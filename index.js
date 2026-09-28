import { chromium } from 'playwright';
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

dotenv.config();

const ansi = {
  reset: '\x1b[0m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  err: '\x1b[31m',
};

function writeLog(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  const formatted = process.env.NO_COLOR === undefined
    ? `${ansi[level]}${line}${ansi.reset}`
    : line;
  if (level === 'err') console.error(formatted);
  else if (level === 'warn') console.warn(formatted);
  else console.log(formatted);
}

const log = {
  debug: (message) => writeLog('debug', message),
  info: (message) => writeLog('info', message),
  warn: (message) => writeLog('warn', message),
  err: (message) => writeLog('err', message),
};

const optionsPath = '/data/options.json';
let options = {};
if (fs.existsSync(optionsPath)) {
  try {
    options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
    log.info(`Loaded configuration from ${optionsPath}`);
  } catch (error) {
    throw new Error(`Could not parse ${optionsPath}: ${error.message}`);
  }
}

const value = (option, environment, fallback) => options[option] ?? process.env[environment] ?? fallback;

function positiveNumber(raw, name, { integer = false } = {}) {
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) {
    throw new Error(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return number;
}

function nonNegativeNumber(raw, name, { integer = false } = {}) {
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new Error(`${name} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
  return number;
}

function booleanValue(raw, name) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string' && ['true', 'false'].includes(raw.toLowerCase())) return raw.toLowerCase() === 'true';
  throw new Error(`${name} must be true or false`);
}

const config = {
  url: String(value('url', 'HA_URL', 'http://127.0.0.1:6123/lovelace?kiosk')),
  token: String(value('token', 'HA_TOKEN', '') ?? ''),
  width: positiveNumber(value('width', 'RESOLUTION_WIDTH', 360), 'width', { integer: true }),
  height: positiveNumber(value('height', 'RESOLUTION_HEIGHT', 640), 'height', { integer: true }),
  zoom: positiveNumber(value('zoom', 'ZOOM_LEVEL', 0.75), 'zoom'),
  durationMs: positiveNumber(value('duration', 'CAPTURE_DURATION_SECONDS', 30), 'duration', { integer: true }) * 1000,
  waitUntilLoaded: booleanValue(value('wait_until_loaded', 'WAIT_UNTIL_LOADED', true), 'wait_until_loaded'),
  delayAfterLoadedMs: nonNegativeNumber(value('delay_after_loaded', 'DELAY_AFTER_LOADED_SECONDS', 2), 'delay_after_loaded', { integer: true }) * 1000,
  cronSchedule: String(value('cron', 'CRON_SCHEDULE', '*/30 * * * *')),
  outputType: String(value('output_type', 'OUTPUT_TYPE', 'mp4')).toLowerCase(),
  framerate: positiveNumber(value('framerate', 'FRAMERATE', 30), 'framerate', { integer: true }),
  outputPathBase: String(value('output_path', 'OUTPUT_PATH', '/config/www/ha-extractor/output')),
};

if (!['webp', 'mp4'].includes(config.outputType)) throw new Error(`output_type must be "webp" or "mp4", got "${config.outputType}"`);
if (!cron.validate(config.cronSchedule)) throw new Error(`Invalid cron schedule: ${config.cronSchedule}`);
try { new URL(config.url); } catch { throw new Error(`Invalid HA_URL: ${config.url}`); }

const tempDir = path.resolve(process.env.TEMP_VIDEO_DIR || './temp_videos');
const playerTemplate = fs.readFileSync(new URL('./player.html', import.meta.url), 'utf8');
let captureRunning = false;
let pendingEncodes = 0;
let captureSequence = 0;
let encodeSequence = 0;
let encodeQueue = Promise.resolve();
let stopping = false;
let scheduledTask;
let sharedBrowser;

async function ensurePlayerPage(finalOutputPath) {
  const playerPath = path.join(path.dirname(finalOutputPath), 'index.html');
  const sourceName = path.basename(finalOutputPath);
  const versionName = `${sourceName}.version`;
  const playerHtml = playerTemplate
    .replaceAll('__SOURCE_NAME__', JSON.stringify(sourceName))
    .replaceAll('__VERSION_NAME__', JSON.stringify(versionName))
    .replaceAll('__OUTPUT_TYPE__', JSON.stringify(config.outputType));
  const temporaryPlayerPath = `${playerPath}.tmp-${process.pid}`;
  await fsp.writeFile(temporaryPlayerPath, playerHtml, 'utf8');
  await fsp.rename(temporaryPlayerPath, playerPath);
}

async function writeOutputVersion(outputPath) {
  const versionPath = `${outputPath}.version`;
  const temporaryVersionPath = `${versionPath}.tmp-${process.pid}`;
  await fsp.writeFile(temporaryVersionPath, `${Date.now()}\n`, 'utf8');
  await fsp.rename(temporaryVersionPath, versionPath);
}

async function getBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;

  log.info('Launching shared Chromium process');
  sharedBrowser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  sharedBrowser.once('disconnected', () => {
    log.warn('Chromium disconnected; it will be relaunched for the next capture');
    sharedBrowser = undefined;
  });
  return sharedBrowser;
}

async function closeSharedBrowser() {
  const browser = sharedBrowser;
  sharedBrowser = undefined;
  if (browser) await browser.close().catch((error) => log.warn(`Could not close Chromium cleanly: ${error.message}`));
}

async function captureDashboard() {
  if (captureRunning || stopping) {
    log.warn('Capture skipped because another recording is active or shutdown is in progress.');
    return;
  }

  captureRunning = true;
  const captureId = ++captureSequence;
  let context;
  let videoPath;
  const extension = config.outputType === 'mp4' ? '.mp4' : '.webp';
  const finalOutputPath = `${config.outputPathBase}${extension}`;

  try {
    await fsp.mkdir(path.dirname(finalOutputPath), { recursive: true });
    await fsp.mkdir(tempDir, { recursive: true });
    await ensurePlayerPage(finalOutputPath);
    log.info(`Starting capture #${captureId}`);

    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: config.width, height: config.height },
      recordVideo: { dir: tempDir, size: { width: config.width, height: config.height } },
    });

    if (config.token) {
      const hassUrl = new URL(config.url).origin;
      await context.addInitScript(({ token, hassUrl: origin }) => {
        window.localStorage.setItem('hassTokens', JSON.stringify({
          access_token: token, expires_in: 315360000, refresh_token: '', token_type: 'Bearer',
          clientId: origin, hassUrl: origin,
        }));
      }, { token: config.token, hassUrl });
    }

    const page = await context.newPage();
    log.info(`Navigating to ${config.url}`);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (config.waitUntilLoaded) {
      log.info('Waiting for Home Assistant data');
      await page.waitForFunction(() => {
        const app = document.querySelector('home-assistant');
        const hass = app?.hass;
        return Boolean(hass?.connection?.connected && hass.states && Object.keys(hass.states).length > 0);
      }, undefined, { timeout: 60_000 });
      if (config.delayAfterLoadedMs > 0) {
        log.info(`Waiting ${config.delayAfterLoadedMs / 1000} seconds after Home Assistant loaded`);
        await page.waitForTimeout(config.delayAfterLoadedMs);
      }
      log.info('Home Assistant data ready; starting recording');
    } else {
      log.info('Skipping Home Assistant readiness wait');
    }
    await page.evaluate((zoom) => { document.body.style.zoom = String(zoom); }, config.zoom);
    log.info(`Recording capture #${captureId} for ${config.durationMs / 1000} seconds`);
    await page.waitForTimeout(config.durationMs);

    await context.close();
    videoPath = await page.video().path();
    context = undefined;

    const completedVideoPath = videoPath;
    videoPath = undefined;
    log.info(`Capture #${captureId} finished; encoding queued`);
    enqueueEncoding(completedVideoPath, finalOutputPath, extension, captureId);
  } catch (error) {
    log.err(`Capture #${captureId} failed: ${error.message}`);
  } finally {
    if (context) await context.close().catch(() => { });
    if (videoPath) await fsp.rm(videoPath, { force: true }).catch(() => { });
    captureRunning = false;
  }
}

function enqueueEncoding(videoPath, finalOutputPath, extension, captureId) {
  const encodingId = ++encodeSequence;
  pendingEncodes += 1;
  encodeQueue = encodeQueue.then(async () => {
    const temporaryOutputPath = `${finalOutputPath}.tmp-${process.pid}-${encodingId}${extension}`;
    const encodingStartedAt = Date.now();
    try {
      log.info(`Encoding capture #${captureId} as ${finalOutputPath}`);
      await transcodeVideo(videoPath, temporaryOutputPath);
      await fsp.rename(temporaryOutputPath, finalOutputPath);
      await writeOutputVersion(finalOutputPath);
      log.info(`Capture #${captureId} complete; encoding took ${((Date.now() - encodingStartedAt) / 1000).toFixed(1)} seconds`);
    } catch (error) {
      log.err(`Encoding capture #${captureId} failed: ${error.message}`);
    } finally {
      await fsp.rm(videoPath, { force: true }).catch(() => { });
      await fsp.rm(temporaryOutputPath, { force: true }).catch(() => { });
      pendingEncodes -= 1;
    }
  });
}

function transcodeVideo(inputPath, outputPath) {
  const filters = `fps=${config.framerate}`;
  const durationSeconds = String(config.durationMs / 1000);
  const input = ['-sseof', `-${durationSeconds}`, '-i', inputPath, '-t', durationSeconds];
  const args = config.outputType === 'mp4'
    ? ['-y', ...input, '-vf', filters, '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', outputPath]
    : ['-y', ...input, '-vf', filters, '-c:v', 'libwebp', '-threads', '0', '-lossless', '0', '-compression_level', '0', '-q:v', '50', '-loop', '0', '-an', outputPath];

  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => reject(new Error(`Could not start FFmpeg: ${error.message}`)));
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-2000)}`)));
  });
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  scheduledTask?.stop();
  log.info(`Received ${signal}; waiting for the active capture to finish`);
  while (captureRunning || pendingEncodes > 0) await new Promise((resolve) => setTimeout(resolve, 250));
  await closeSharedBrowser();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

log.info('HA Extractor started');
log.info(`Settings: ${config.width}x${config.height}, zoom=${config.zoom}, duration=${config.durationMs / 1000}s, waitUntilLoaded=${config.waitUntilLoaded}, delayAfterLoaded=${config.delayAfterLoadedMs / 1000}s, ${config.framerate}fps ${config.outputType}`);
log.info(`Settings: url=${config.url}, output=${config.outputPathBase}${config.outputType === 'mp4' ? '.mp4' : '.webp'}, schedule=${config.cronSchedule}`);

void captureDashboard();
scheduledTask = cron.schedule(config.cronSchedule, () => void captureDashboard());

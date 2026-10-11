import { NextRequest, NextResponse } from 'next/server';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import archiver from 'archiver';
import { buildDownloadReport } from '@/lib/youtube/excel';
import { YTDLP_FILENAME_TEMPLATE, YTDLP_FORMAT_SELECTOR } from '@/lib/youtube/download';
import { classifyPlatform } from '@/lib/youtube/platform';
import { ensureYtDlpBinary, runYtDlp, YtDlpError } from '@/lib/youtube/ytdlp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_VIDEOS = 30;
const MAX_URL_LENGTH = 2048;
const RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const DOWNLOAD_DELAY_MS = 1000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function downloadOne(url: string, outputDirectory: string): Promise<string | null> {
  const args = [
    url,
    '-f',
    YTDLP_FORMAT_SELECTOR,
    '-o',
    join(/* turbopackIgnore: true */ outputDirectory, YTDLP_FILENAME_TEMPLATE),
    '--retries',
    String(RETRIES),
    '--fragment-retries',
    String(RETRIES),
  ];
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      await runYtDlp(args);
      return null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < RETRIES) {
        console.warn(`[url-batch] Retry ${attempt + 1}/${RETRIES} for ${url}: ${lastError.message}`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  return lastError?.message ?? 'Unknown yt-dlp error';
}

function getUrls(form: FormData): { urls?: string[]; error?: string } {
  const values = form.getAll('url');
  if (values.some((value) => typeof value !== 'string')) {
    return { error: 'Each video link must be a URL.' };
  }
  const urls = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
  if (urls.length === 0) return { error: 'Add at least one video link to download.' };
  if (urls.length > MAX_VIDEOS) {
    return { error: `A batch can contain at most ${MAX_VIDEOS} unique video links.` };
  }
  for (const url of urls) {
    if (url.length > MAX_URL_LENGTH) {
      return { error: 'One or more links are too long.' };
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      return { error: 'Every link must be a valid http:// or https:// URL.' };
    }
  }
  return { urls };
}

export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Could not read the submitted video links.' }, { status: 400 });
  }

  const parsed = getUrls(form);
  if (!parsed.urls) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  let workDir: string | null = null;
  try {
    await ensureYtDlpBinary();
    workDir = await mkdtemp(join(/* turbopackIgnore: true */ tmpdir(), 'url-batch-download-'));
    const succeeded: string[] = [];
    const failed: { url: string; error: string }[] = [];

    for (let index = 0; index < parsed.urls.length; index++) {
      const url = parsed.urls[index];
      const platform = classifyPlatform(url);
      const outputDirectory = join(/* turbopackIgnore: true */ workDir, platform);
      await mkdir(outputDirectory, { recursive: true });

      console.log(`[url-batch] [${index + 1}/${parsed.urls.length}] Downloading: ${url}`);
      const error = await downloadOne(url, outputDirectory);
      if (error) {
        failed.push({ url, error });
        console.error(`[url-batch] [${index + 1}/${parsed.urls.length}] FAILED: ${error}`);
      } else {
        succeeded.push(url);
        console.log(`[url-batch] [${index + 1}/${parsed.urls.length}] OK`);
      }
      if (index < parsed.urls.length - 1) await sleep(DOWNLOAD_DELAY_MS);
    }

    await writeFile(
      join(/* turbopackIgnore: true */ workDir, 'download_report.txt'),
      buildDownloadReport(succeeded, failed),
      'utf8'
    );

    const archive = archiver('zip', { zlib: { level: 6 } });
    const body = new PassThrough();
    archive.on('warning', (error) => console.warn('[url-batch] ZIP warning:', error));
    archive.on('error', (error) => body.destroy(error));
    archive.pipe(body);
    archive.directory(workDir, false);

    body.on('close', () => {
      archive.abort();
      if (workDir) rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    });
    void archive.finalize().catch((error) => body.destroy(error));

    const webStream = Readable.toWeb(body) as unknown as ReadableStream;
    return new Response(webStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="video-downloads.zip"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const statusCode = error instanceof YtDlpError ? error.statusCode : undefined;
    const message = error instanceof Error ? error.message : 'Batch download failed.';
    console.error('[url-batch] Failed:', message);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    return NextResponse.json(
      {
        error:
          statusCode === 404
            ? 'One or more videos are unavailable.'
            : 'Could not prepare the batch download. Check the server logs for details.',
      },
      { status: statusCode === 404 ? 404 : 500 }
    );
  }
}

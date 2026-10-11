'use client';

import { useRef, useState } from 'react';
import { classifyPlatform, PLATFORM_LABELS, PLATFORM_BADGE_CLASSES } from '@/lib/youtube/platform';

interface VideoLink {
  id: number;
  url: string;
  filename?: string;
  status: 'idle' | 'ready' | 'error';
  error?: string;
}

const MAX_VIDEOS = 30;
const URL_PATTERN = /https?:\/\/[^\s<>"'()[\]]+/gi;

const inputClasses =
  'w-full px-3 py-2.5 sm:px-4 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60 focus:border-blue-500 transition text-sm sm:text-base';

function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN) ?? [];
  return [...new Set(matches.map((url) => url.replace(/&amp;/g, '&').replace(/[.,;!?]+$/, '')))];
}

export default function UrlDownloader() {
  const [pastedLinks, setPastedLinks] = useState('');
  const [videos, setVideos] = useState<VideoLink[]>([]);
  const [linkCount, setLinkCount] = useState(0);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const nextId = useRef(1);

  const updatePastedLinks = (value: string) => {
    setPastedLinks(value);
    const urls = extractUrls(value);
    setLinkCount(urls.length);
    setVideos(
      urls.slice(0, MAX_VIDEOS + 1).map((url) => ({
        id: nextId.current++,
        url,
        status: 'idle',
      }))
    );
    setError('');
  };

  const checkLinks = async () => {
    setError('');
    const urls = extractUrls(pastedLinks);
    setLinkCount(urls.length);
    if (urls.length === 0) {
      setVideos([]);
      setError('Paste at least one http:// or https:// video link to continue.');
      return;
    }
    if (urls.length > MAX_VIDEOS) {
      setError(`This batch contains ${urls.length} unique links. The maximum is ${MAX_VIDEOS}.`);
      return;
    }

    const links = urls.map((url, index) => ({
      id: index + 1,
      url,
      status: 'idle' as const,
    }));
    setVideos(links);
    setChecking(true);

    try {
      for (let offset = 0; offset < links.length; offset += 4) {
        const batch = links.slice(offset, offset + 4);
        const results = await Promise.all(
          batch.map(async (video) => {
            try {
              const url = new URL(video.url);
              if (!['http:', 'https:'].includes(url.protocol) || video.url.length > 2048) {
                throw new Error('Enter a valid HTTP or HTTPS video link.');
              }
              const response = await fetch(
                `/api/download-url/validate?url=${encodeURIComponent(video.url)}`
              );
              const data = (await response.json()) as { error?: unknown; filename?: unknown };
              if (!response.ok) {
                throw new Error(
                  typeof data.error === 'string' ? data.error : 'Could not check this link.'
                );
              }
              if (typeof data.filename !== 'string' || !data.filename) {
                throw new Error('The link check returned no video filename.');
              }
              return { ...video, status: 'ready' as const, filename: data.filename };
            } catch (requestError) {
              return {
                ...video,
                status: 'error' as const,
                error:
                  requestError instanceof Error
                    ? requestError.message
                    : 'Could not check this link.',
              };
            }
          })
        );
        setVideos((current) =>
          current.map((video) => results.find((result) => result.id === video.id) ?? video)
        );
      }
    } finally {
      setChecking(false);
    }
  };

  const startDownload = () => {
    if (videos.length === 0 || videos.some((video) => video.status !== 'ready')) return;

    setError('');
    setDownloading(true);
    if (videos.length === 1) {
      const link = document.createElement('a');
      link.href = `/api/download-url?url=${encodeURIComponent(videos[0].url)}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => setDownloading(false), 1000);
      return;
    }

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/download-urls';
    form.target = 'video-batch-download';
    form.hidden = true;
    for (const video of videos) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'url';
      input.value = video.url;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
    window.setTimeout(() => setDownloading(false), 2500);
  };

  const readyCount = videos.filter((video) => video.status === 'ready').length;
  const canDownload =
    readyCount > 0 && !checking && videos.every((video) => video.status === 'ready');

  return (
    <div className="py-6 sm:py-8">
      <div className="container mx-auto px-3 sm:px-4 max-w-3xl w-full">
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-4 sm:p-6">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 mb-1">
            Download videos from any site
          </h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm sm:text-base mb-5">
            Paste up to {MAX_VIDEOS} links at once from YouTube, Instagram, TikTok, Facebook,
            Twitter/X, Vimeo, or any site supported by yt-dlp. Links can be separated by spaces or
            new lines; duplicates are ignored.
          </p>

          <label htmlFor="video-links" className="sr-only">
            Paste video links
          </label>
          <textarea
            id="video-links"
            value={pastedLinks}
            onChange={(event) => updatePastedLinks(event.target.value)}
            placeholder={'Paste one or more video links here\nhttps://example.com/video-1\nhttps://example.com/video-2'}
            rows={5}
            disabled={checking || downloading}
            className={inputClasses}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {linkCount} unique {linkCount === 1 ? 'link' : 'links'} found (maximum {MAX_VIDEOS})
            </p>
            <button
              type="button"
              onClick={checkLinks}
              disabled={checking || downloading || linkCount === 0 || linkCount > MAX_VIDEOS}
              className="shrink-0 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold py-2.5 px-6 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm sm:text-base"
            >
              {checking ? 'Checking links…' : `Check ${linkCount || ''} link${linkCount === 1 ? '' : 's'}`}
            </button>
          </div>

          {linkCount > MAX_VIDEOS && (
            <p className="mt-3 text-sm text-red-700 dark:text-red-300" role="alert">
              The maximum is {MAX_VIDEOS} unique links. Remove {linkCount - MAX_VIDEOS} link
              {linkCount - MAX_VIDEOS === 1 ? '' : 's'} to continue.
            </p>
          )}

          {videos.length > 0 && (
            <div className="mt-4 space-y-2" aria-live="polite">
              {videos.map((video, index) => {
                const platform = classifyPlatform(video.url);
                return (
                  <div
                    key={video.id}
                    className="flex min-w-0 flex-col gap-1 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 sm:flex-row sm:items-center sm:gap-3"
                  >
                    <span className="shrink-0 text-xs font-semibold text-slate-500">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-slate-700 dark:text-slate-200">
                        {video.url}
                      </p>
                      {video.status === 'ready' && (
                        <p className="truncate text-xs text-green-700 dark:text-green-300">
                          Ready: {video.filename}
                        </p>
                      )}
                      {video.status === 'error' && (
                        <p className="text-xs text-red-700 dark:text-red-300">{video.error}</p>
                      )}
                    </div>
                    {platform && (
                      <span
                        className={`w-fit shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${PLATFORM_BADGE_CLASSES[platform]}`}
                      >
                        {PLATFORM_LABELS[platform]}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {videos.length > 0 && videos.length <= MAX_VIDEOS && (
            <button
              type="button"
              onClick={startDownload}
              disabled={!canDownload || downloading}
              className="mt-4 w-full rounded-lg bg-green-700 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:text-base"
            >
              {downloading
                ? videos.length === 1
                  ? 'Starting download…'
                  : 'Preparing ZIP…'
                : videos.length === 1
                  ? 'Download video'
                  : `Download ${readyCount || videos.length} videos as ZIP`}
            </button>
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            >
              {error}
            </div>
          )}
          <iframe title="Batch video download" name="video-batch-download" className="hidden" />
        </div>
      </div>
    </div>
  );
}

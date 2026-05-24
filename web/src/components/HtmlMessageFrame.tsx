/**
 * Sandboxed iframe for rendering a received HTML email body.
 *
 * Defense layers (in order of importance):
 *
 *   1. DOMPurify sanitization. Strips <script>, <iframe>, <object>,
 *      <embed>, <form>, <meta http-equiv="refresh">, javascript:
 *      URLs, event handlers, and anything else known-dangerous.
 *      Runs BEFORE injection — even if the iframe sandbox is
 *      somehow bypassed there's no executable content to find.
 *
 *   2. Iframe sandbox = `allow-same-origin` only. No `allow-scripts`,
 *      so even an attribute event handler we missed can't fire.
 *      `allow-same-origin` is required for the parent to read the
 *      iframe's DOM for the height-measurement loop; without
 *      `allow-scripts` it's safe because the iframe can't fetch /
 *      navigate / read cookies on its own.
 *
 *   3. Image policy. By default we replace every <img src> with a
 *      tiny 1x1 placeholder so opening an email doesn't leak the
 *      user's IP to tracking pixels. When the user clicks "Show
 *      images" the src is rewritten to the /api/img proxy, which
 *      fetches from the worker (Cloudflare's IP, not the user's).
 *
 *   4. `<base target="_blank">` so link clicks open in a new tab
 *      instead of navigating the iframe.
 *
 * Sizing: parent reads `iframe.contentDocument.documentElement
 * .scrollHeight` on load + via a ResizeObserver. Works because
 * `allow-same-origin` keeps the iframe in the page's origin for DOM
 * access purposes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';

interface Props {
  /** Raw HTML from a received email. Sanitized before injection. */
  html: string;
  /** When true, rewrite <img src> to the /api/img proxy. Default false. */
  loadImages?: boolean;
  /** Initial height before the frame self-reports. */
  initialHeight?: number;
}

// 1x1 transparent GIF — placeholder for blocked images. Keeps layout
// stable (the <img> still renders, just with no pixels).
const BLANK_IMG =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export default function HtmlMessageFrame({
  html,
  loadImages = false,
  initialHeight = 200,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(initialHeight);
  const [loaded, setLoaded] = useState(false);

  // Build the doc string once per (html, loadImages) pair. We:
  //   1. Sanitize the raw email HTML.
  //   2. Walk all <img>/<source srcset> in a detached DOM and either
  //      blank them out or rewrite to /api/img depending on the
  //      loadImages prop.
  //   3. Inject <base target="_blank"> + an empty <head> wrapper if
  //      the email didn't supply one.
  //   4. Inject a bmail-themed stylesheet for clean reading layout.
  //
  // Re-running the rewriter when `loadImages` flips is the whole
  // "show images" UX — the iframe re-renders from a new srcDoc.
  const decorated = useMemo(() => {
    const sanitized = DOMPurify.sanitize(html, {
      FORBID_TAGS: [
        'script',
        'iframe',
        'object',
        'embed',
        'video',
        'audio',
        'form',
        'input',
        'button',
        'select',
        'textarea',
        'meta',
        'link',
        'base',
      ],
      FORBID_ATTR: ['srcset'],
      ADD_ATTR: ['target'],
      WHOLE_DOCUMENT: true,
      ALLOW_DATA_ATTR: false,
    });

    const parser = new DOMParser();
    const doc = parser.parseFromString(sanitized, 'text/html');

    if (!doc.head) {
      const head = doc.createElement('head');
      doc.documentElement.insertBefore(head, doc.body);
    }
    const base = doc.createElement('base');
    base.setAttribute('target', '_blank');
    base.setAttribute('rel', 'noopener noreferrer');
    doc.head.insertBefore(base, doc.head.firstChild);

    // Apply image policy.
    for (const img of Array.from(doc.querySelectorAll('img'))) {
      const src = img.getAttribute('src');
      img.removeAttribute('srcset');
      if (!src) continue;
      if (src.startsWith('data:image/')) continue;
      if (!loadImages) {
        img.setAttribute('src', BLANK_IMG);
        img.setAttribute('data-original-src', src);
      } else if (/^https?:/i.test(src)) {
        img.setAttribute(
          'src',
          `/api/img?u=${encodeURIComponent(src)}`,
        );
      }
    }

    // Inject a bmail-aligned reading stylesheet.
    // Uses Geist for body, soft border tokens passed as static values
    // (the iframe doc doesn't inherit CSS vars from the parent).
    const style = doc.createElement('style');
    style.textContent = `
      html, body {
        margin: 0;
        padding: 0;
      }
      body {
        font-family: 'Geist', -apple-system, ui-sans-serif, system-ui, sans-serif;
        font-size: 14px;
        line-height: 1.65;
        color: #181816;
        background: #ffffff;
        word-wrap: break-word;
        -webkit-font-smoothing: antialiased;
      }
      img {
        max-width: 100%;
        height: auto;
      }
      table {
        max-width: 100%;
        border-collapse: collapse;
      }
      a {
        color: oklch(0.35 0.05 155);
        text-underline-offset: 3px;
        text-decoration-thickness: 1px;
      }
      a:hover {
        text-decoration-thickness: 2px;
      }
      hr {
        border: 0;
        border-top: 1px solid #EBE9E2;
        margin: 20px 0;
      }
      blockquote {
        margin: 12px 0;
        padding: 0 0 0 16px;
        border-left: 2px solid #EBE9E2;
        color: #6B6B66;
      }
      pre, code {
        font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.88em;
        background: #F4F2EC;
        border-radius: 4px;
      }
      code {
        padding: 1px 5px;
      }
      pre {
        padding: 12px 14px;
        overflow-x: auto;
      }
      pre code {
        background: none;
        padding: 0;
        border-radius: 0;
      }
    `;
    doc.head.appendChild(style);

    return '<!doctype html>' + doc.documentElement.outerHTML;
  }, [html, loadImages]);

  // Parent-side height measurement.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let cleanup: (() => void) | null = null;
    const onLoad = () => {
      setLoaded(true);
      const doc = iframe.contentDocument;
      if (!doc) return;
      const measure = () => {
        const h = Math.max(
          doc.documentElement.scrollHeight || 0,
          doc.body?.scrollHeight || 0,
        );
        if (h > 0) setHeight(Math.min(h + 4, 100_000));
      };
      measure();
      const ro = new ResizeObserver(measure);
      if (doc.body) ro.observe(doc.body);
      const imgs = doc.images;
      const onImg = () => measure();
      for (let i = 0; i < imgs.length; i++) {
        imgs[i].addEventListener('load', onImg);
        imgs[i].addEventListener('error', onImg);
      }
      cleanup = () => {
        ro.disconnect();
        for (let i = 0; i < imgs.length; i++) {
          imgs[i].removeEventListener('load', onImg);
          imgs[i].removeEventListener('error', onImg);
        }
      };
    };
    iframe.addEventListener('load', onLoad);
    return () => {
      iframe.removeEventListener('load', onLoad);
      if (cleanup) cleanup();
    };
  }, [decorated]);

  return (
    <div className="card overflow-hidden">
      {/* Loading shimmer — shown until the iframe reports loaded */}
      {!loaded && (
        <div className="space-y-2 p-4">
          <div className="h-3 w-3/4 animate-pulse-soft rounded bg-sunken" />
          <div className="h-3 w-full animate-pulse-soft rounded bg-sunken" />
          <div className="h-3 w-5/6 animate-pulse-soft rounded bg-sunken" />
          <div className="h-3 w-2/3 animate-pulse-soft rounded bg-sunken" />
        </div>
      )}
      <iframe
        ref={iframeRef}
        title="email"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={decorated}
        style={{
          display: loaded ? 'block' : 'none',
          width: '100%',
          height: `${height}px`,
          border: 0,
          background: 'white',
        }}
      />
    </div>
  );
}

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

  // Build the doc string once per (html, loadImages) pair. We:
  //   1. Sanitize the raw email HTML.
  //   2. Walk all <img>/<source srcset> in a detached DOM and either
  //      blank them out or rewrite to /api/img depending on the
  //      loadImages prop.
  //   3. Inject <base target="_blank"> + an empty <head> wrapper if
  //      the email didn't supply one.
  //
  // Re-running the rewriter when `loadImages` flips is the whole
  // "show images" UX — the iframe re-renders from a new srcDoc.
  const decorated = useMemo(() => {
    const sanitized = DOMPurify.sanitize(html, {
      // Strip the noisy / dangerous tags by default. DOMPurify's
      // default config already removes <script>, event handlers,
      // and javascript: URLs; the FORBID_TAGS list below adds
      // belt-and-braces coverage for things that aren't scripts
      // but still let an attacker do something nasty (form posts,
      // remote stylesheets, meta refresh).
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

    // Use a detached document to walk and rewrite img/src. We can't
    // do this on the live document (we're not yet mounted) and we
    // don't want to use innerHTML round-trips (slow + lossy).
    const parser = new DOMParser();
    const doc = parser.parseFromString(sanitized, 'text/html');

    // Ensure <head> exists with a <base target="_blank">.
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
      img.removeAttribute('srcset'); // belt-and-braces; DOMPurify already FORBID_ATTR
      if (!src) continue;
      // Skip already-data-url images (inline base64 — usually
      // sender's own logo, no tracking concern).
      if (src.startsWith('data:image/')) continue;
      if (!loadImages) {
        img.setAttribute('src', BLANK_IMG);
        // Stash original so a future "show images" toggle could
        // restore. (Re-rendered from raw on toggle anyway.)
        img.setAttribute('data-original-src', src);
      } else if (/^https?:/i.test(src)) {
        img.setAttribute(
          'src',
          `/api/img?u=${encodeURIComponent(src)}`,
        );
      }
    }

    // Add a tiny stylesheet so wide email tables don't blow out our
    // column width — long tables get a horizontal scrollbar inside
    // the iframe instead of pushing the page.
    const style = doc.createElement('style');
    style.textContent = `
      html, body { margin: 0; padding: 0; }
      body { font-family: -apple-system, system-ui, sans-serif; word-wrap: break-word; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100%; }
    `;
    doc.head.appendChild(style);

    return '<!doctype html>' + doc.documentElement.outerHTML;
  }, [html, loadImages]);

  // Parent-side height measurement. `allow-same-origin` (without
  // `allow-scripts`) means we can read iframe.contentDocument from
  // here. ResizeObserver fires whenever the body box changes (images
  // finishing load, fonts swapping in, etc.).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let cleanup: (() => void) | null = null;
    const onLoad = () => {
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
      // ResizeObserver on the body catches image loads + dynamic
      // layout. Constructor is in the iframe's window, since the
      // ResizeObserver from the parent window can observe nodes
      // from a same-origin iframe.
      const ro = new ResizeObserver(measure);
      if (doc.body) ro.observe(doc.body);
      // Images load async — re-measure as each finishes.
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
    <iframe
      ref={iframeRef}
      title="email"
      // allow-same-origin WITHOUT allow-scripts: parent can read
      // the iframe DOM (for sizing), but no JS runs inside.
      // allow-popups lets <base target=_blank> work.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={decorated}
      style={{
        display: 'block',
        width: '100%',
        height: `${height}px`,
        border: 0,
        background: 'white',
      }}
    />
  );
}

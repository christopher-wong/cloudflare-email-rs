import { Link } from 'react-router-dom';

/**
 * Marketing / landing page. Visually frozen in the original brutalist B&W
 * look — explicitly self-contained so the rest of the app can migrate to
 * the new design system without altering the landing's appearance. All
 * styles live in the scoped <style> block below; no dependency on the
 * global tokens defined in src/styles.css.
 */
export default function Landing() {
  return (
    <div className="landing-root">
      <style>{LANDING_CSS}</style>

      <div className="landing-wrap">
        <header className="landing-hair-b landing-header">
          <div className="landing-label">BMAIL</div>
          <nav className="landing-nav">
            <a
              href="https://github.com/christopher-wong/cloudflare-email-rs"
              target="_blank"
              rel="noreferrer noopener"
              className="landing-label landing-link"
            >
              source ▸
            </a>
            <Link to="/login" className="landing-btn landing-btn-primary landing-label">
              sign in ▸
            </Link>
          </nav>
        </header>

        <section className="landing-section landing-hero">
          <div className="landing-label">PRIVATE EMAIL</div>
          <h1 className="landing-h1">mail that nobody else reads.</h1>
          <p className="landing-lede">
            Your inbox is locked with a key only your phone has. Sign
            in with your face or fingerprint — no password to remember.
          </p>
          <div className="landing-cta-row">
            <Link
              to="/login"
              className="landing-btn landing-btn-primary landing-label landing-btn-lg"
            >
              sign in with passkey ▸
            </Link>
          </div>
          <p className="landing-mute landing-tiny">
            new here? ask an admin for an enrollment link.
          </p>
        </section>

        <section className="landing-hair-all landing-grid-3">
          <Feature
            tag="01"
            title="we can't read your mail"
            body="your messages and attachments are locked with a key that only your phone or laptop has. open them with your face, your fingerprint, or a hardware key, the same way you unlock your phone."
          />
          <Feature
            tag="02"
            title="no passwords"
            body="we don't ask for one. there's nothing to forget, nothing for a phishing site to steal, and nothing in a database for an attacker to dump."
            left
          />
          <Feature
            tag="03"
            title="works like normal email"
            body="send and receive from any address. plus addresses, attachments, threads. nothing to install. just visit on any device with a passkey."
            left
          />
        </section>

        <section className="landing-hair-all landing-block-pad landing-mt-6">
          <div className="landing-label">HOW YOUR MAIL IS PROTECTED</div>
          <p className="landing-body landing-mt-2">
            The moment a message arrives, we lock it with your personal
            key. That key lives in your phone or laptop, behind your
            face, fingerprint, or hardware key. It is never written to a
            disk in plain form and never sent to a server. We hold the
            locked copy. You hold the only key that opens it.
          </p>
          <p className="landing-mute landing-tiny landing-mt-3">
            What still has to be readable on our side: the envelope (who
            sent it, who it&apos;s for, the date, the message ID), so we
            can deliver it to the right inbox and group replies into the
            right conversation.
          </p>
          <p className="landing-mute landing-tiny landing-mt-3">
            What we can&apos;t protect: messages you send to people who
            don&apos;t use bmail. They leave our system as a normal
            email, so the person you wrote to and their email provider
            (Gmail, Outlook, anywhere else) can read them like any other
            message. End-to-end privacy needs both sides. Until your
            recipient is also encrypted, that last step is regular
            email. This is the same compromise Proton Mail and every
            other privacy-focused email service makes.
          </p>
        </section>

        <section className="landing-hair-t landing-mt-10 landing-pt-8 landing-center">
          <div className="landing-label">HOSTED HERE · SELF-HOST AVAILABLE</div>
          <p className="landing-mute landing-body landing-mx-xl landing-mt-3">
            You&apos;re looking at a hosted instance. If you&apos;d rather
            run your own, on your own Cloudflare account, your own
            domain, your own data, keep reading.
          </p>
        </section>

        <section className="landing-mt-6 landing-hair-all landing-pad-8">
          <div className="landing-label">SELF-HOSTABLE · OPEN SOURCE</div>
          <h2 className="landing-h2">your cloudflare, your data.</h2>
          <p className="landing-body landing-mt-3">
            bmail is open source and runs end-to-end on a single
            Cloudflare account. one wrangler deploy and you&apos;re your
            own email provider. no servers to babysit, no third-party
            mail relay, no plaintext at rest.
          </p>

          <ul className="landing-hair-t landing-mt-6 landing-grid-2 landing-pt-6 landing-body">
            <li>· Cloudflare Workers (Rust, workers-rs)</li>
            <li>· Durable Objects (SQLite-backed)</li>
            <li>· R2 for ciphertext blobs</li>
            <li>· Email Routing (inbound) + Email Sending (outbound)</li>
            <li>· React + Vite + Tailwind frontend</li>
            <li>· WebAuthn PRF + X25519 sealed boxes</li>
          </ul>

          <div className="landing-hair-t landing-mt-6 landing-pt-6 landing-stats">
            <Stat k="0" v="plaintext bytes at rest" />
            <Stat k="1" v="wrangler deploy" left />
            <Stat k="MIT" v="open source license" left />
          </div>

          <div className="landing-cta-row-wrap">
            <a
              href="https://github.com/christopher-wong/cloudflare-email-rs"
              target="_blank"
              rel="noreferrer noopener"
              className="landing-btn landing-btn-primary landing-label landing-btn-lg"
            >
              source on github ▸
            </a>
            <a
              href="https://github.com/christopher-wong/cloudflare-email-rs#first-time-setup"
              target="_blank"
              rel="noreferrer noopener"
              className="landing-btn landing-label landing-btn-lg"
            >
              deploy your own ▸
            </a>
          </div>
        </section>

        <footer className="landing-footer">
          <span className="landing-label">BMAIL // OPEN SOURCE</span>
          <a
            href="https://github.com/christopher-wong/cloudflare-email-rs"
            target="_blank"
            rel="noreferrer noopener"
            className="landing-mute landing-link"
          >
            github
          </a>
        </footer>
      </div>
    </div>
  );
}

function Feature({
  tag,
  title,
  body,
  left = false,
}: {
  tag: string;
  title: string;
  body: string;
  left?: boolean;
}) {
  return (
    <div className={'landing-feature ' + (left ? 'landing-hair-l' : '')}>
      <div className="landing-label">{tag}</div>
      <h3 className="landing-h3">{title}</h3>
      <p className="landing-body landing-mt-3">{body}</p>
    </div>
  );
}

function Stat({ k, v, left = false }: { k: string; v: string; left?: boolean }) {
  return (
    <div className={'landing-stat ' + (left ? 'landing-hair-l' : '')}>
      <div className="landing-stat-k">{k}</div>
      <div className="landing-label landing-mt-2">{v}</div>
    </div>
  );
}

/* Scoped, self-contained styles. Anything matching `.landing-root .*` keeps
 * the original brutalist B&W look regardless of the global token system. */
const LANDING_CSS = `
.landing-root {
  background: #fff;
  color: #000;
  font-family: 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-feature-settings: 'liga' 0, 'calt' 0;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  min-height: 100%;
}
.landing-root a { color: inherit; text-decoration: none; }

.landing-wrap { max-width: 48rem; margin: 0 auto; padding: 2.5rem 1.5rem; }

.landing-header {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 1rem;
}
.landing-nav { display: flex; align-items: center; gap: 0.75rem; }

.landing-label {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.6875rem;
  font-weight: 500;
  line-height: 1;
}

.landing-link { border-bottom: 0; }
.landing-link:hover { background: #000; color: #fff; }

.landing-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #000;
  background: #fff;
  color: #000;
  padding: 0.5rem 0.875rem;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  font-family: inherit;
  text-decoration: none;
}
.landing-btn:hover { background: #000; color: #fff; }
.landing-btn-primary { background: #000; color: #fff; }
.landing-btn-primary:hover { background: #fff; color: #000; }
.landing-btn-lg { padding: 0.75rem 1rem; }

.landing-section { padding-top: 3.5rem; padding-bottom: 3.5rem; }
.landing-hero { text-align: center; }
.landing-h1 {
  margin-top: 0.75rem;
  font-size: 3rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
.landing-h2 {
  margin-top: 0.75rem;
  font-size: 1.875rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.15;
}
.landing-h3 {
  margin-top: 0.75rem;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.3;
}
.landing-lede {
  margin: 1.25rem auto 0;
  max-width: 36rem;
  font-size: 1rem;
  line-height: 1.75;
}
.landing-body { font-size: 0.875rem; line-height: 1.5rem; }
.landing-tiny { font-size: 0.75rem; line-height: 1.25rem; }
.landing-mute { color: #999; }

.landing-cta-row { margin-top: 1.75rem; display: flex; align-items: center; justify-content: center; gap: 0.75rem; }
.landing-cta-row-wrap { margin-top: 1.75rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }

.landing-hair-b { border-bottom: 1px solid #000; }
.landing-hair-t { border-top: 1px solid #000; }
.landing-hair-l { border-left: 1px solid #000; }
.landing-hair-all { border: 1px solid #000; }

.landing-grid-3 { display: grid; grid-template-columns: 1fr; }
@media (min-width: 768px) { .landing-grid-3 { grid-template-columns: 1fr 1fr 1fr; } }

.landing-feature { padding: 1.5rem; }

.landing-block-pad { padding: 1.5rem; }
.landing-pad-8 { padding: 2rem; }

.landing-mt-2 { margin-top: 0.5rem; }
.landing-mt-3 { margin-top: 0.75rem; }
.landing-mt-6 { margin-top: 1.5rem; }
.landing-mt-10 { margin-top: 2.5rem; }
.landing-pt-6 { padding-top: 1.5rem; }
.landing-pt-8 { padding-top: 2rem; }
.landing-mx-xl { max-width: 36rem; margin-left: auto; margin-right: auto; }
.landing-center { text-align: center; }

.landing-grid-2 {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.5rem 1rem;
}
@media (min-width: 768px) { .landing-grid-2 { grid-template-columns: 1fr 1fr; } }

.landing-stats { display: grid; grid-template-columns: 1fr; gap: 1rem; }
@media (min-width: 768px) { .landing-stats { grid-template-columns: 1fr 1fr 1fr; gap: 0; } }
.landing-stat { padding: 1.5rem; text-align: center; }
.landing-stat-k { font-size: 1.875rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }

.landing-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2rem 0;
  font-size: 0.75rem;
}
`;

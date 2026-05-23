import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="hair-b flex items-center justify-between pb-4">
        <div className="label">CFEMAIL</div>
        <nav className="flex items-center gap-3">
          <a
            href="https://github.com/"
            target="_blank"
            rel="noreferrer noopener"
            className="label border-b-0"
          >
            source ▸
          </a>
          <Link to="/login" className="btn btn-primary label">
            sign in ▸
          </Link>
        </nav>
      </header>

      <section className="py-14 text-center">
        <div className="label">EMAIL ON CLOUDFLARE</div>
        <h1 className="mt-3 text-5xl font-bold tracking-tight">
          mail that the server can&apos;t read.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-sm leading-6">
          a self-hostable email web app. every subject, body and attachment is
          sealed to your key before it touches storage. no passwords. no
          plaintext at rest. one wrangler deploy.
        </p>
        <div className="mt-7 flex items-center justify-center gap-3">
          <Link to="/login" className="btn btn-primary label px-4 py-3">
            sign in with passkey ▸
          </Link>
          <a
            href="#features"
            className="btn label px-4 py-3 border-b"
          >
            how it works
          </a>
        </div>
      </section>

      <section id="features" className="hair-all grid grid-cols-1 md:grid-cols-3">
        <Feature
          tag="01 / ENCRYPTION"
          title="sealed to your key"
          body="subject, body and attachments are encrypted with X25519 sealed boxes (XChaCha20-Poly1305) the moment your worker receives them. the server never sees plaintext again."
          foot="from / to / date stay readable — needed for routing and threading. same trade-off as Proton."
        />
        <Feature
          tag="02 / AUTH"
          title="passkeys only"
          body="WebAuthn with the PRF extension unwraps your private key. Touch ID, Windows Hello, hardware keys. no passwords to phish, no SMS to swap."
          foot="recovery is a 12-word phrase, Argon2id-stretched. you control both."
          border="hair-l"
        />
        <Feature
          tag="03 / DEPLOY"
          title="your cloudflare, your data"
          body="open source. one Worker (Rust), Durable Objects for state, R2 for ciphertext blobs, Email Routing inbound, Email Sending outbound. no third-party servers."
          foot="bring your domain. wrangler deploy. done."
          border="hair-l"
        />
      </section>

      <section className="hair-l hair-r hair-b grid grid-cols-1 md:grid-cols-3">
        <Stat k="0" v="plaintext bytes at rest" />
        <Stat k="X25519" v="sealed boxes per message" border="hair-l" />
        <Stat k="1" v="wrangler deploy" border="hair-l" />
      </section>

      <section className="hair-l hair-r hair-b p-6">
        <div className="label">WHAT&apos;S NOT ENCRYPTED</div>
        <p className="mt-2 text-sm leading-6">
          envelope metadata (from / to / date / message-id) is stored in the
          clear so the worker can route and thread mail. everything in the
          envelope you&apos;d normally read — subject, body, attachments — is
          sealed before it lands.
        </p>
      </section>

      <section className="hair-l hair-r hair-b p-6">
        <div className="label">STACK</div>
        <ul className="mt-3 grid grid-cols-2 gap-y-1 text-sm md:grid-cols-3">
          <li>— Cloudflare Workers (Rust)</li>
          <li>— Durable Objects (SQLite)</li>
          <li>— R2 blob storage</li>
          <li>— Email Routing inbound</li>
          <li>— Email Sending outbound</li>
          <li>— React + Vite + Tailwind</li>
        </ul>
      </section>

      <section className="hair-l hair-r hair-b p-8 text-center">
        <h2 className="text-2xl font-bold">ready?</h2>
        <p className="mt-2 text-sm">
          existing user — sign in with your passkey.
          <br />
          new user — ask an admin for an enrollment link.
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <Link to="/login" className="btn btn-primary label px-4 py-3">
            sign in ▸
          </Link>
        </div>
      </section>

      <footer className="flex items-center justify-between py-6 text-xs">
        <span className="label">CFEMAIL // OPEN SOURCE</span>
        <span className="text-mute">brutalist by choice.</span>
      </footer>
    </div>
  );
}

function Feature({
  tag,
  title,
  body,
  foot,
  border = '',
}: {
  tag: string;
  title: string;
  body: string;
  foot: string;
  border?: string;
}) {
  return (
    <div className={'p-6 ' + border}>
      <div className="label">{tag}</div>
      <h3 className="mt-3 text-xl font-bold">{title}</h3>
      <p className="mt-3 text-sm leading-6">{body}</p>
      <p className="text-mute mt-4 text-xs leading-5">{foot}</p>
    </div>
  );
}

function Stat({ k, v, border = '' }: { k: string; v: string; border?: string }) {
  return (
    <div className={'p-6 text-center ' + border}>
      <div className="text-3xl font-bold tracking-tight">{k}</div>
      <div className="label mt-2">{v}</div>
    </div>
  );
}

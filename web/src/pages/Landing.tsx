import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="hair-b flex items-center justify-between pb-4">
        <div className="label">BMAIL</div>
        <nav className="flex items-center gap-3">
          <a
            href="https://github.com/christopher-wong/cloudflare-email-rs"
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

      {/* -- MARKETING --
          No jargon, no stack mentions. The pitch is the privacy
          guarantee in plain language and a single, obvious CTA. */}
      <section className="py-14 text-center">
        <div className="label">PRIVATE EMAIL</div>
        <h1 className="mt-3 text-5xl font-bold tracking-tight">
          mail that nobody else reads.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-base leading-7">
          Your inbox is locked with a key only your phone has. Sign
          in with your face or fingerprint — no password to remember.
        </p>
        <div className="mt-7 flex items-center justify-center gap-3">
          <Link to="/login" className="btn btn-primary label px-4 py-3">
            sign in with passkey ▸
          </Link>
        </div>
        <p className="text-mute mt-6 text-xs">
          new here? ask an admin for an enrollment link.
        </p>
      </section>

      <section className="hair-all grid grid-cols-1 md:grid-cols-3">
        <Feature
          tag="01"
          title="we can't read your mail"
          body="your messages and attachments are locked with a key that only your phone or laptop has. open them with your face, your fingerprint, or a hardware key, the same way you unlock your phone."
        />
        <Feature
          tag="02"
          title="no passwords"
          body="we don't ask for one. there's nothing to forget, nothing for a phishing site to steal, and nothing in a database for an attacker to dump."
          border="hair-l"
        />
        <Feature
          tag="03"
          title="works like normal email"
          body="send and receive from any address. plus addresses, attachments, threads. nothing to install. just visit on any device with a passkey."
          border="hair-l"
        />
      </section>

      {/* The hosted vs self-host split. The line above the divider is
          aimed at end-users; below is for developers / operators who
          want to run their own copy. */}
      <section className="mt-10 hair-t pt-8 text-center">
        <div className="label">HOSTED HERE · SELF-HOST AVAILABLE</div>
        <p className="text-mute mx-auto mt-3 max-w-xl text-sm leading-6">
          You&apos;re looking at a hosted instance. If you&apos;d rather
          run your own, on your own Cloudflare account, your own
          domain, your own data, keep reading.
        </p>
      </section>

      {/* -- TECHNICAL / SELF-HOST --
          For the developer audience. Stack details, the deploy story,
          and a direct link to the repo. */}
      <section className="mt-6 hair-all p-8">
        <div className="label">SELF-HOSTABLE · OPEN SOURCE</div>
        <h2 className="mt-3 text-3xl font-bold tracking-tight">
          your cloudflare, your data.
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-6">
          bmail is open source and runs end-to-end on a single
          Cloudflare account. one wrangler deploy and you&apos;re your
          own email provider. no servers to babysit, no third-party
          mail relay, no plaintext at rest.
        </p>

        <ul className="hair-t mt-6 grid grid-cols-1 gap-y-2 pt-6 text-sm leading-6 md:grid-cols-2">
          <li>· Cloudflare Workers (Rust, workers-rs)</li>
          <li>· Durable Objects (SQLite-backed)</li>
          <li>· R2 for ciphertext blobs</li>
          <li>· Email Routing (inbound) + Email Sending (outbound)</li>
          <li>· React + Vite + Tailwind frontend</li>
          <li>· WebAuthn PRF + X25519 sealed boxes</li>
        </ul>

        <div className="hair-t mt-6 grid grid-cols-1 gap-4 pt-6 md:grid-cols-3">
          <Stat k="0" v="plaintext bytes at rest" />
          <Stat k="1" v="wrangler deploy" border="hair-l" />
          <Stat k="MIT" v="open source license" border="hair-l" />
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <a
            href="https://github.com/christopher-wong/cloudflare-email-rs"
            target="_blank"
            rel="noreferrer noopener"
            className="btn btn-primary label px-4 py-3"
          >
            source on github ▸
          </a>
          <a
            href="https://github.com/christopher-wong/cloudflare-email-rs#first-time-setup"
            target="_blank"
            rel="noreferrer noopener"
            className="btn label px-4 py-3"
          >
            deploy your own ▸
          </a>
        </div>
      </section>

      <section className="hair-all hair-t-0 mt-6 p-6">
        <div className="label">HOW YOUR MAIL IS PROTECTED</div>
        <p className="mt-2 text-sm leading-6">
          The moment a message arrives, we lock it with your personal
          key. That key lives in your phone or laptop, behind your
          face, fingerprint, or hardware key. It is never written to a
          disk in plain form and never sent to a server. We hold the
          locked copy. You hold the only key that opens it.
        </p>
        <p className="text-mute mt-3 text-xs leading-5">
          What still has to be readable on our side: the envelope (who
          sent it, who it&apos;s for, the date, the message ID), so we
          can deliver it to the right inbox and group replies into the
          right conversation.
        </p>
        <p className="text-mute mt-3 text-xs leading-5">
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

      <footer className="flex items-center justify-between py-8 text-xs">
        <span className="label">BMAIL // OPEN SOURCE</span>
        <a
          href="https://github.com/christopher-wong/cloudflare-email-rs"
          target="_blank"
          rel="noreferrer noopener"
          className="text-mute border-b-0"
        >
          github
        </a>
      </footer>
    </div>
  );
}

function Feature({
  tag,
  title,
  body,
  border = '',
}: {
  tag: string;
  title: string;
  body: string;
  border?: string;
}) {
  return (
    <div className={'p-6 ' + border}>
      <div className="label">{tag}</div>
      <h3 className="mt-3 text-xl font-bold">{title}</h3>
      <p className="mt-3 text-sm leading-6">{body}</p>
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

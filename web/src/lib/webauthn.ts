/**
 * WebAuthn ceremonies + recovery flow.
 *
 * The X25519 private key that decrypts the user's mailbox lives in three
 * places, never simultaneously:
 *
 *   1. Browser memory (right now, this tab) — unwrapped, AES-GCM-protected
 *      at rest by Chrome/Safari's process boundary.
 *   2. On the server — AES-GCM-wrapped under one or more wrap keys.
 *      Wrap keys are either WebAuthn PRF outputs (per passkey) or
 *      Argon2id(recovery-phrase, salt).
 *   3. On paper — the 12-word recovery phrase, written down by the user.
 *
 * Losing any single one is fine. Losing all of them = locked out forever.
 */

import * as api from './api';
import {
  KdfParams,
  b64uDecode,
  b64uEncode,
  deriveRecoveryWrapKey,
  deriveWrapKey,
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  newRecoverySalt,
  newX25519Keypair,
  openSealedBox,
  unwrapPrivKey,
  wrapPrivKey,
} from './crypto';

export class PrfUnsupportedError extends Error {
  constructor() {
    super(
      'Your device or browser does not support the WebAuthn PRF extension, which cfemail requires. Try a different device or browser (Chrome 116+, Safari 17.4+, Firefox 122+).',
    );
  }
}

// -- Registration -----------------------------------------------------------

export interface RegistrationResult {
  user_id: string;
  is_admin: boolean;
  addresses: string[];
  /** 12-word BIP39 mnemonic. Show ONCE to the user, then zero from memory. */
  recovery_phrase: string;
}

export async function registerWithInvite(
  inviteToken: string,
  opts?: { handle?: string; displayName?: string; credLabel?: string },
): Promise<RegistrationResult> {
  const options = await api.post<RegisterOptionsResp>('/api/auth/register/options', {
    invite_token: inviteToken,
  });

  const prfSalt = b64uDecode(options.prf_salt_b64);

  const publicKey: PublicKeyCredentialCreationOptions = {
    rp: { id: options.rp.id, name: options.rp.name },
    user: {
      id: b64uDecode(options.user.id),
      name: options.user.name,
      displayName: options.user.display_name,
    },
    challenge: b64uDecode(options.challenge),
    pubKeyCredParams: options.pub_key_cred_params.map((p) => ({
      type: p.type as PublicKeyCredentialType,
      alg: p.alg,
    })),
    authenticatorSelection: {
      userVerification: options.authenticator_selection.user_verification as UserVerificationRequirement,
      residentKey: options.authenticator_selection.resident_key as ResidentKeyRequirement,
      requireResidentKey: options.authenticator_selection.require_resident_key,
    },
    timeout: options.timeout,
    attestation: options.attestation as AttestationConveyancePreference,
    extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
  };

  const credential = (await navigator.credentials.create({ publicKey })) as
    | PublicKeyCredential
    | null;
  if (!credential) throw new Error('credential creation aborted');

  const extResults = credential.getClientExtensionResults() as any;
  let prfFirst: ArrayBuffer | undefined = extResults?.prf?.results?.first;
  if (!prfFirst) {
    // Some authenticators only surface PRF on assertion, not create.
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: options.rp.id,
        allowCredentials: [
          { id: new Uint8Array((credential as any).rawId), type: 'public-key' },
        ],
        userVerification: 'preferred',
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    const ext = assertion?.getClientExtensionResults() as any;
    prfFirst = ext?.prf?.results?.first;
  }
  if (!prfFirst) throw new PrfUnsupportedError();

  // Generate the single X25519 keypair that all wraps will protect.
  const { priv, pub } = newX25519Keypair();

  // Wrap #1: passkey wrap (PRF → AES-GCM key)
  const passkeyWrapKey = await deriveWrapKey(prfFirst);
  const { wrapped: passkeyWrapped, salt: passkeyWrapSalt } = await wrapPrivKey(
    priv,
    passkeyWrapKey,
  );

  // Wrap #2: recovery wrap (Argon2id(BIP39 phrase) → AES-GCM key)
  const phrase = generateRecoveryPhrase();
  const recoverySalt = newRecoverySalt();
  const { wrapKey: recoveryWrapKey, params: kdfParams } = await deriveRecoveryWrapKey(
    phrase,
    recoverySalt,
  );
  const { wrapped: recoveryWrapped } = await wrapPrivKey(priv, recoveryWrapKey);

  const ar = credential.response as AuthenticatorAttestationResponse;
  const transports = (ar.getTransports?.() as string[]) || [];

  const result = await api.post<{
    user_id: string;
    is_admin: boolean;
    addresses: string[];
  }>('/api/auth/register/verify', {
    invite_token: inviteToken,
    challenge_id: options.challenge_id,
    handle: opts?.handle,
    display_name: opts?.displayName,
    cred_label: opts?.credLabel,
    attestation: {
      credential_id_b64: b64uEncode(new Uint8Array(credential.rawId)),
      client_data_json_b64: b64uEncode(new Uint8Array(ar.clientDataJSON)),
      attestation_object_b64: b64uEncode(new Uint8Array(ar.attestationObject)),
      transports,
    },
    pub_key_b64: b64uEncode(pub),
    wraps: [
      {
        kind: 'passkey',
        credential_id_b64: b64uEncode(new Uint8Array(credential.rawId)),
        wrapped_blob_b64: b64uEncode(passkeyWrapped),
        wrap_salt_b64: b64uEncode(passkeyWrapSalt),
        label: opts?.credLabel ?? null,
      },
      {
        kind: 'recovery',
        wrapped_blob_b64: b64uEncode(recoveryWrapped),
        wrap_salt_b64: null,
        kdf_params: JSON.stringify(kdfParams),
        label: null,
      },
    ],
  });

  await sessionStashPriv(priv);
  return {
    user_id: result.user_id,
    is_admin: result.is_admin,
    addresses: result.addresses,
    recovery_phrase: phrase,
  };
}

// -- Passkey login ----------------------------------------------------------

export interface LoginResult {
  user_id: string;
  handle: string;
  display_name: string | null;
  is_admin: boolean;
  addresses: string[];
  pub_key_b64: string | null;
  priv: Uint8Array;
}

interface LoginVerifyResp {
  user: {
    id: string;
    handle: string;
    display_name: string | null;
    is_admin: boolean;
    addresses: string[];
    pub_key_b64: string | null;
  };
  wrap: {
    wrapped_blob_b64: string;
    wrap_salt_b64: string | null;
  };
}

export async function login(): Promise<LoginResult> {
  const options = await api.post<LoginOptionsResp>('/api/auth/login/options', {});
  const prfSalt = b64uDecode(options.prf_salt_b64);

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: b64uDecode(options.challenge),
    rpId: options.rp_id,
    userVerification: options.user_verification as UserVerificationRequirement,
    timeout: options.timeout,
    extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
  };

  const assertion = (await navigator.credentials.get({
    publicKey,
    mediation: 'optional',
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error('login aborted');

  const ext = assertion.getClientExtensionResults() as any;
  const prfFirst: ArrayBuffer | undefined = ext?.prf?.results?.first;
  if (!prfFirst) throw new PrfUnsupportedError();

  const ar = assertion.response as AuthenticatorAssertionResponse;
  const resp = await api.post<LoginVerifyResp>('/api/auth/login/verify', {
    challenge_id: options.challenge_id,
    credential_id_b64: b64uEncode(new Uint8Array(assertion.rawId)),
    client_data_json_b64: b64uEncode(new Uint8Array(ar.clientDataJSON)),
    authenticator_data_b64: b64uEncode(new Uint8Array(ar.authenticatorData)),
    signature_b64: b64uEncode(new Uint8Array(ar.signature)),
  });

  const wrapKey = await deriveWrapKey(prfFirst);
  const priv = await unwrapPrivKey(b64uDecode(resp.wrap.wrapped_blob_b64), wrapKey);
  await sessionStashPriv(priv);

  return {
    user_id: resp.user.id,
    handle: resp.user.handle,
    display_name: resp.user.display_name,
    is_admin: resp.user.is_admin,
    addresses: resp.user.addresses,
    pub_key_b64: resp.user.pub_key_b64,
    priv,
  };
}

// -- Recovery login ---------------------------------------------------------

interface RecoveryBeginResp {
  user_id: string;
  wrap: {
    wrapped_blob_b64: string;
    wrap_salt_b64: string | null;
    kdf_params: string | null;
  };
  sealed_proof_b64: string;
  challenge_id: string;
}

export async function recoveryLogin(handle: string, phrase: string): Promise<LoginResult> {
  if (!isValidRecoveryPhrase(phrase)) {
    throw new Error('that recovery phrase is not a valid 12-word BIP39 mnemonic');
  }
  const begin = await api.post<RecoveryBeginResp>('/api/auth/recovery/begin', {
    handle,
  });
  if (!begin.wrap.kdf_params) throw new Error('server returned no KDF params for recovery wrap');
  const kdfParams: KdfParams = JSON.parse(begin.wrap.kdf_params);

  // Derive the wrap key from the phrase (this is the slow step).
  const { wrapKey } = await deriveRecoveryWrapKey(phrase, kdfParams);
  const priv = await unwrapPrivKey(b64uDecode(begin.wrap.wrapped_blob_b64), wrapKey);

  // Prove possession by decrypting the sealed proof token.
  const proof = openSealedBox(b64uDecode(begin.sealed_proof_b64), priv);

  const user = await api.post<{
    id: string;
    handle: string;
    display_name: string | null;
    is_admin: boolean;
    addresses: string[];
    pub_key_b64: string | null;
  }>('/api/auth/recovery/verify', {
    challenge_id: begin.challenge_id,
    proof_b64: b64uEncode(proof),
  });

  await sessionStashPriv(priv);
  return {
    user_id: user.id,
    handle: user.handle,
    display_name: user.display_name,
    is_admin: user.is_admin,
    addresses: user.addresses,
    pub_key_b64: user.pub_key_b64,
    priv,
  };
}

// -- Add a passkey (user is already logged in) ----------------------------

export async function addPasskey(opts?: { label?: string }): Promise<void> {
  const priv = sessionPriv();
  if (!priv) throw new Error('not signed in');

  const options = await api.post<RegisterOptionsResp & {
    exclude_credentials: { type: string; id: string }[];
  }>('/api/me/passkeys/add/options', {});

  const prfSalt = b64uDecode(options.prf_salt_b64);
  const publicKey: PublicKeyCredentialCreationOptions = {
    rp: { id: options.rp.id, name: options.rp.name },
    user: {
      id: b64uDecode(options.user.id),
      name: options.user.name,
      displayName: options.user.display_name,
    },
    challenge: b64uDecode(options.challenge),
    pubKeyCredParams: options.pub_key_cred_params.map((p) => ({
      type: p.type as PublicKeyCredentialType,
      alg: p.alg,
    })),
    authenticatorSelection: {
      userVerification: options.authenticator_selection.user_verification as UserVerificationRequirement,
      residentKey: options.authenticator_selection.resident_key as ResidentKeyRequirement,
      requireResidentKey: options.authenticator_selection.require_resident_key,
    },
    timeout: options.timeout,
    attestation: options.attestation as AttestationConveyancePreference,
    extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
    excludeCredentials: options.exclude_credentials.map((c) => ({
      type: c.type as PublicKeyCredentialType,
      id: b64uDecode(c.id),
    })),
  };

  const credential = (await navigator.credentials.create({ publicKey })) as
    | PublicKeyCredential
    | null;
  if (!credential) throw new Error('aborted');

  const ext = credential.getClientExtensionResults() as any;
  let prfFirst: ArrayBuffer | undefined = ext?.prf?.results?.first;
  if (!prfFirst) {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: options.rp.id,
        allowCredentials: [
          { id: new Uint8Array((credential as any).rawId), type: 'public-key' },
        ],
        userVerification: 'preferred',
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    const e = assertion?.getClientExtensionResults() as any;
    prfFirst = e?.prf?.results?.first;
  }
  if (!prfFirst) throw new PrfUnsupportedError();

  // Derive the new passkey's wrap key + wrap the in-memory priv with it.
  const wrapKey = await deriveWrapKey(prfFirst);
  const { wrapped, salt } = await wrapPrivKey(priv, wrapKey);

  const ar = credential.response as AuthenticatorAttestationResponse;
  await api.post('/api/me/passkeys/add/verify', {
    challenge_id: options.challenge_id,
    cred_label: opts?.label ?? null,
    attestation: {
      credential_id_b64: b64uEncode(new Uint8Array(credential.rawId)),
      client_data_json_b64: b64uEncode(new Uint8Array(ar.clientDataJSON)),
      attestation_object_b64: b64uEncode(new Uint8Array(ar.attestationObject)),
      transports: (ar.getTransports?.() as string[]) || [],
    },
    wrapped_blob_b64: b64uEncode(wrapped),
    wrap_salt_b64: b64uEncode(salt),
  });
}

// -- Session-scoped priv ----------------------------------------------------

const PRIV_HANDLE = '__cfemail_priv_session__';

export async function sessionStashPriv(priv: Uint8Array): Promise<void> {
  (window as any)[PRIV_HANDLE] = priv;
}
export function sessionPriv(): Uint8Array | null {
  return (window as any)[PRIV_HANDLE] || null;
}
export function sessionClearPriv(): void {
  const p = (window as any)[PRIV_HANDLE] as Uint8Array | undefined;
  if (p) p.fill(0);
  (window as any)[PRIV_HANDLE] = null;
}

// -- Wire types -------------------------------------------------------------

interface RegisterOptionsResp {
  rp: { id: string; name: string };
  user: { id: string; name: string; display_name: string };
  challenge: string;
  pub_key_cred_params: { type: string; alg: number }[];
  authenticator_selection: {
    user_verification: string;
    resident_key: string;
    require_resident_key: boolean;
  };
  timeout: number;
  attestation: string;
  challenge_id: string;
  prf_salt_b64: string;
  invite_handle?: string | null;
  invite_addresses?: string[];
  invite_is_admin?: boolean;
}

interface LoginOptionsResp {
  rp_id: string;
  challenge: string;
  challenge_id: string;
  timeout: number;
  user_verification: string;
  prf_salt_b64: string;
}

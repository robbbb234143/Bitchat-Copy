(function () {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const symmetricAlgorithm = "AES-GCM";
  const identityStorageKey = "bitchat.identity.v2";

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  async function sha256Base64(input) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
    return arrayBufferToBase64(digest);
  }

  async function importEcdsaPrivateJwk(jwk) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"]
    );
  }

  async function importEcdsaPublicJwk(jwk) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"]
    );
  }

  async function importEcdhPrivateJwk(jwk) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
  }

  async function importEcdhPublicJwk(jwk) {
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );
  }

  async function getOrCreateIdentity() {
    const stored = localStorage.getItem(identityStorageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        const signingPrivateKey = await importEcdsaPrivateJwk(parsed.signingPrivateJwk);
        const signingPublicKey = await importEcdsaPublicJwk(parsed.signingPublicJwk);
        const ecdhPrivateKey = await importEcdhPrivateJwk(parsed.ecdhPrivateJwk);
        const ecdhPublicKey = await importEcdhPublicJwk(parsed.ecdhPublicJwk);

        return {
          fingerprint: parsed.fingerprint,
          signingPrivateJwk: parsed.signingPrivateJwk,
          signingPublicJwk: parsed.signingPublicJwk,
          ecdhPrivateJwk: parsed.ecdhPrivateJwk,
          ecdhPublicJwk: parsed.ecdhPublicJwk,
          signingPrivateKey,
          signingPublicKey,
          ecdhPrivateKey,
          ecdhPublicKey
        };
      } catch {
        localStorage.removeItem(identityStorageKey);
      }
    }

    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const ecdh = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );

    const signingPrivateJwk = await crypto.subtle.exportKey("jwk", signing.privateKey);
    const signingPublicJwk = await crypto.subtle.exportKey("jwk", signing.publicKey);
    const ecdhPrivateJwk = await crypto.subtle.exportKey("jwk", ecdh.privateKey);
    const ecdhPublicJwk = await crypto.subtle.exportKey("jwk", ecdh.publicKey);

    const fingerprint = (await sha256Base64(JSON.stringify(signingPublicJwk))).slice(0, 24);
    localStorage.setItem(identityStorageKey, JSON.stringify({
      fingerprint,
      signingPrivateJwk,
      signingPublicJwk,
      ecdhPrivateJwk,
      ecdhPublicJwk
    }));

    return {
      fingerprint,
      signingPrivateJwk,
      signingPublicJwk,
      ecdhPrivateJwk,
      ecdhPublicJwk,
      signingPrivateKey: signing.privateKey,
      signingPublicKey: signing.publicKey,
      ecdhPrivateKey: ecdh.privateKey,
      ecdhPublicKey: ecdh.publicKey
    };
  }

  function stableJson(value) {
    return JSON.stringify(value);
  }

  async function signString(identity, dataString) {
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.signingPrivateKey,
      encoder.encode(dataString)
    );
    return arrayBufferToBase64(signature);
  }

  async function verifyString(signingPublicJwk, dataString, signatureBase64) {
    const key = await importEcdsaPublicJwk(signingPublicJwk);
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64ToArrayBuffer(signatureBase64),
      encoder.encode(dataString)
    );
  }

  async function buildSignedBundle(identity, username) {
    const payload = {
      username,
      fingerprint: identity.fingerprint,
      signingPublicKeyJwk: identity.signingPublicJwk,
      ecdhPublicKeyJwk: identity.ecdhPublicJwk
    };
    const signature = await signString(identity, stableJson(payload));
    return {
      ...payload,
      signature
    };
  }

  async function verifySignedBundle(bundle) {
    if (!bundle || typeof bundle !== "object") {
      return { ok: false, reason: "missing-bundle" };
    }

    const payload = {
      username: bundle.username,
      fingerprint: bundle.fingerprint,
      signingPublicKeyJwk: bundle.signingPublicKeyJwk,
      ecdhPublicKeyJwk: bundle.ecdhPublicKeyJwk
    };

    try {
      const verified = await verifyString(
        bundle.signingPublicKeyJwk,
        stableJson(payload),
        String(bundle.signature || "")
      );

      const computedFingerprint = (await sha256Base64(JSON.stringify(bundle.signingPublicKeyJwk))).slice(0, 24);
      if (computedFingerprint !== bundle.fingerprint) {
        return { ok: false, reason: "fingerprint-mismatch" };
      }

      return { ok: verified, reason: verified ? "ok" : "invalid-signature", fingerprint: computedFingerprint };
    } catch {
      return { ok: false, reason: "verify-error" };
    }
  }

  async function derivePairKey(identity, peerEcdhPublicJwk) {
    const peerPublic = await importEcdhPublicJwk(peerEcdhPublicJwk);
    const bits = await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: peerPublic
      },
      identity.ecdhPrivateKey,
      256
    );

    return crypto.subtle.importKey(
      "raw",
      bits,
      { name: symmetricAlgorithm, length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptWithAesKey(key, plainText) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: symmetricAlgorithm, iv },
      key,
      encoder.encode(plainText)
    );

    return JSON.stringify({
      v: 1,
      alg: symmetricAlgorithm,
      iv: arrayBufferToBase64(iv),
      ciphertext: arrayBufferToBase64(ciphertext)
    });
  }

  async function decryptWithAesKey(key, payload) {
    const parsed = JSON.parse(payload);
    if (!parsed || parsed.v !== 1 || parsed.alg !== symmetricAlgorithm) {
      throw new Error("Invalid ciphertext payload.");
    }

    const plaintext = await crypto.subtle.decrypt(
      { name: symmetricAlgorithm, iv: new Uint8Array(base64ToArrayBuffer(parsed.iv)) },
      key,
      base64ToArrayBuffer(parsed.ciphertext)
    );

    return decoder.decode(plaintext);
  }

  async function encryptForPeer(identity, peerEcdhPublicJwk, plainText) {
    const key = await derivePairKey(identity, peerEcdhPublicJwk);
    return encryptWithAesKey(key, plainText);
  }

  async function decryptFromPeer(identity, peerEcdhPublicJwk, payload) {
    const key = await derivePairKey(identity, peerEcdhPublicJwk);
    return decryptWithAesKey(key, payload);
  }

  function generateSenderKey() {
    return arrayBufferToBase64(crypto.getRandomValues(new Uint8Array(32)));
  }

  async function importSenderKey(senderKeyBase64) {
    return crypto.subtle.importKey(
      "raw",
      base64ToArrayBuffer(senderKeyBase64),
      { name: symmetricAlgorithm, length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptWithSenderKey(senderKeyBase64, plainText) {
    const key = await importSenderKey(senderKeyBase64);
    return encryptWithAesKey(key, plainText);
  }

  async function decryptWithSenderKey(senderKeyBase64, payload) {
    const key = await importSenderKey(senderKeyBase64);
    return decryptWithAesKey(key, payload);
  }

  async function signPayload(identity, payload) {
    return signString(identity, stableJson(payload));
  }

  async function verifyPayload(signingPublicJwk, payload, signature) {
    return verifyString(signingPublicJwk, stableJson(payload), signature);
  }

  function parseCiphertext(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  window.ChatCrypto = {
    getOrCreateIdentity,
    buildSignedBundle,
    verifySignedBundle,
    encryptForPeer,
    decryptFromPeer,
    generateSenderKey,
    encryptWithSenderKey,
    decryptWithSenderKey,
    signPayload,
    verifyPayload,
    parseCiphertext
  };
})();
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const openpgp = require("openpgp");

const keyDir = path.join(__dirname, ".pgp");
const publicKeyPath = path.join(keyDir, "public.asc");
const privateKeyPath = path.join(keyDir, "private.asc");
const passphrasePath = path.join(keyDir, "passphrase.txt");

let publicKeyArmored = "";
let privateKeyArmored = "";
let passphrase = "";
let publicKeyObject;
let privateKeyObject;
let initializationPromise;

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadOrCreateKeyMaterial() {
  await fs.mkdir(keyDir, { recursive: true });

  const hasPublicKey = await fileExists(publicKeyPath);
  const hasPrivateKey = await fileExists(privateKeyPath);
  const hasPassphrase = await fileExists(passphrasePath);

  if (hasPublicKey && hasPrivateKey && hasPassphrase) {
    [publicKeyArmored, privateKeyArmored, passphrase] = await Promise.all([
      fs.readFile(publicKeyPath, "utf8"),
      fs.readFile(privateKeyPath, "utf8"),
      fs.readFile(passphrasePath, "utf8")
    ]);
    return;
  }

  passphrase = crypto.randomBytes(32).toString("hex");
  const keyPair = await openpgp.generateKey({
    type: "rsa",
    rsaBits: 3072,
    userIDs: [
      {
        name: "Bitchat Copy",
        email: "server@localhost"
      }
    ],
    passphrase
  });

  publicKeyArmored = keyPair.publicKey;
  privateKeyArmored = keyPair.privateKey;

  await Promise.all([
    fs.writeFile(publicKeyPath, publicKeyArmored, "utf8"),
    fs.writeFile(privateKeyPath, privateKeyArmored, "utf8"),
    fs.writeFile(passphrasePath, passphrase, "utf8")
  ]);
}

async function initializeCrypto() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await loadOrCreateKeyMaterial();

      const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
      const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });

      publicKeyObject = publicKey;
      privateKeyObject = await openpgp.decryptKey({
        privateKey,
        passphrase
      });
    })();
  }

  return initializationPromise;
}

function looksEncrypted(value) {
  return String(value || "").includes("-----BEGIN PGP MESSAGE-----");
}

async function encryptText(value) {
  await initializeCrypto();

  const message = await openpgp.createMessage({ text: String(value || "") });
  return openpgp.encrypt({
    message,
    encryptionKeys: publicKeyObject
  });
}

async function decryptText(value) {
  if (!looksEncrypted(value)) {
    return String(value || "");
  }

  await initializeCrypto();

  try {
    const message = await openpgp.readMessage({ armoredMessage: String(value) });
    const decrypted = await openpgp.decrypt({
      message,
      decryptionKeys: privateKeyObject
    });

    return decrypted.data;
  } catch {
    return String(value || "");
  }
}

module.exports = {
  initializeCrypto,
  encryptText,
  decryptText
};
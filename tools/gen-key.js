// 生成 RSA 公钥(写进 manifest "key") + 推算固定扩展 ID。
// 私钥存 tools/omeety-key.pem（仅发布到商店时需要；勿公开提交）。
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})

const keyB64 = publicKey.toString("base64") // → manifest "key"
const hash = crypto.createHash("sha256").update(publicKey).digest()
let id = ""
for (let i = 0; i < 16; i++) {
  id += String.fromCharCode(97 + (hash[i] >> 4))
  id += String.fromCharCode(97 + (hash[i] & 0x0f))
}

fs.writeFileSync(path.join(__dirname, "omeety-key.pem"), privateKey)
console.log("KEY=" + keyB64)
console.log("ID=" + id)

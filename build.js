#!/usr/bin/env node
// Builds dist/lrusso-popup-window-<version>.zip, the package to upload to the
// Chrome Web Store. Everything under src/ goes into the zip root, plus LICENSE.
// Needs only Node.js (no dependencies): node build.js
// Runs test.js first and refuses to build if a test fails.

"use strict"

const fs = require("fs")
const path = require("path")
const zlib = require("zlib")
const { spawnSync } = require("child_process")

const ROOT = __dirname
const SRC = path.join(ROOT, "src")
const DIST = path.join(ROOT, "dist")
const NAME = "lrusso-popup-window"
const EXTRA_FILES = ["LICENSE"] // taken from the repository root
const isExcluded = (fileName) =>
  fileName.startsWith(".") || fileName.endsWith(".svg")

const fail = (message) => {
  console.error(`build.js: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Manifest checks
// ---------------------------------------------------------------------------

const readManifest = () => {
  let file = path.join(SRC, "manifest.json")
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    fail(`cannot read ${path.relative(ROOT, file)}: ${error.message}`)
  }
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || "")) {
    fail(`invalid version in manifest.json: ${manifest.version}`)
  }
  let referenced = [
    ...Object.values(manifest.icons || {}),
    ...Object.values((manifest.action && manifest.action.default_icon) || {}),
    manifest.background && manifest.background.service_worker,
    manifest.options_ui && manifest.options_ui.page,
  ].filter(Boolean)
  for (let relative of referenced) {
    if (!fs.existsSync(path.join(SRC, relative))) {
      fail(`manifest.json references a missing file: ${relative}`)
    }
  }
  return manifest
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

const collectFiles = (dir, prefix = "") => {
  let files = []
  for (let entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    if (isExcluded(entry.name)) continue
    let zipPath = prefix + entry.name
    let fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, zipPath + "/"))
    } else if (entry.isFile()) {
      files.push({ zipPath, fullPath })
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// Minimal zip writer (deflate, no directory entries, no extra fields)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

const crc32 = (buffer) => {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++)
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const dosDateTime = (date) => {
  if (date.getFullYear() < 1980) date = new Date(1980, 0, 1)
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date:
      ((date.getFullYear() - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  }
}

const STORED = 0
const DEFLATED = 8
const UNIX_FILE_MODE = (0o100644 << 16) >>> 0 // regular file, rw-r--r--

const buildZip = (files) => {
  let localParts = []
  let centralParts = []
  let offset = 0

  for (let file of files) {
    let data = fs.readFileSync(file.fullPath)
    let deflated = zlib.deflateRawSync(data, { level: 9 })
    let method = deflated.length < data.length ? DEFLATED : STORED
    let payload = method === DEFLATED ? deflated : data
    let name = Buffer.from(file.zipPath, "utf8")
    let flags = /^[\x20-\x7e]*$/.test(file.zipPath) ? 0 : 0x0800 // 0x0800 = UTF-8 file name
    let { time, date } = dosDateTime(fs.statSync(file.fullPath).mtime)
    let crc = crc32(data)

    let local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed to extract: 2.0
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra field length

    let central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory header signature
    central.writeUInt16LE(0x0314, 4) // version made by: Unix, 2.0
    central.writeUInt16LE(20, 6) // version needed to extract: 2.0
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra field length
    central.writeUInt16LE(0, 32) // file comment length
    central.writeUInt16LE(0, 34) // disk number start
    central.writeUInt16LE(0, 36) // internal file attributes
    central.writeUInt32LE(UNIX_FILE_MODE, 38) // external file attributes
    central.writeUInt32LE(offset, 42) // offset of local header

    localParts.push(local, name, payload)
    centralParts.push(central, name)
    offset += local.length + name.length + payload.length
  }

  let centralSize = centralParts.reduce((size, part) => size + part.length, 0)
  let end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  end.writeUInt16LE(0, 4) // this disk
  end.writeUInt16LE(0, 6) // disk with the central directory
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16) // central directory offset
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, ...centralParts, end])
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const runTests = () => {
  let result = spawnSync(process.execPath, [path.join(ROOT, "test.js")], {
    stdio: "inherit",
  })
  if (result.status !== 0) fail("tests failed, no zip was built")
}

const main = () => {
  if (!fs.existsSync(SRC)) fail("src/ folder not found")
  runTests()
  let manifest = readManifest()

  let files = collectFiles(SRC)
  for (let fileName of EXTRA_FILES) {
    let fullPath = path.join(ROOT, fileName)
    if (!fs.existsSync(fullPath)) fail(`missing ${fileName}`)
    files.push({ zipPath: fileName, fullPath })
  }

  fs.mkdirSync(DIST, { recursive: true })
  let output = path.join(DIST, `${NAME}-${manifest.version}.zip`)
  let zip = buildZip(files)
  fs.writeFileSync(output, zip)

  for (let file of files) console.log(`  ${file.zipPath}`)
  console.log(
    `${path.relative(ROOT, output)} (${files.length} files, ${zip.length} bytes)`
  )
}

main()

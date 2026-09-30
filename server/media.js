import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, stat, writeFile, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES = 4;
const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const fail = (key, status = 400) => Object.assign(new Error(key), { errorKey: key, status });
export function imageType(bytes) {
  let mime, width, height;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR') {
    mime = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii',0,6))) {
    mime = 'image/gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
  } else if (bytes.length >= 30 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') {
    mime = 'image/webp'; const chunk = bytes.toString('ascii',12,16);
    if (chunk === 'VP8X') { width = 1 + bytes.readUIntLE(24,3); height = 1 + bytes.readUIntLE(27,3); }
    else if (chunk === 'VP8 ' && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    else if (chunk === 'VP8L' && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = 1 + (bits & 16383); height = 1 + ((bits >>> 14) & 16383); }
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg'; let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 7) { height = bytes.readUInt16BE(offset+3); width = bytes.readUInt16BE(offset+5); break; }
      offset += length;
    }
  }
  if (!mime || !width || !height || width > 16384 || height > 16384 || width * height > 40000000) throw fail('media.invalid');
  return mime;
}
function decode(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100) throw fail('media.size', 413);
  const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match || !match[2] || match[2].length % 4) throw fail('media.invalid');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw fail('media.size', 413);
  const mime = imageType(bytes);
  if (mime !== match[1]) throw fail('media.invalid');
  return { bytes, mime };
}
async function readImage(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw fail('media.unavailable', 404);
    const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_IMAGE_BYTES + 1));
    let length = 0;
    while (length < bytes.length) { const result = await file.read(bytes, length, bytes.length-length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > info.size || length > MAX_IMAGE_BYTES) throw fail('media.size', 413);
    const data = bytes.subarray(0,length);
    return { bytes: data, mime: imageType(data) };
  } finally { await file.close(); }
}

export function createMedia({ directory, localFiles = true }) {
  const records = new Map(); let cachedBytes = 0, writing = Promise.resolve();
  function remember(threadId, source, name = 'image') {
    const identity = source.path ? `path:${source.path}` : `data:${source.data}`;
    const id = createHash('sha256').update(threadId).update('\0').update(identity).digest('hex');
    if (!records.has(id)) {
      const size = source.data?.length || 0;
      while (records.size >= 2000 || cachedBytes + size > 64 * 1024 * 1024) {
        const oldest = records.keys().next().value;
        if (!oldest) break;
        cachedBytes -= records.get(oldest).size; records.delete(oldest);
      }
      records.set(id, { threadId, source, size, name }); cachedBytes += size;
    }
    return { id, name, url: `/api/threads/${encodeURIComponent(threadId)}/images/${id}` };
  }
  function dataImage(threadId, value, name) {
    try { decode(value); return remember(threadId, { data: value }, name); } catch { return { unavailable: true, name }; }
  }
  function part(threadId, input) {
    if (input.type === 'localImage') return { type: input.type, remoteImage: localFiles && typeof input.path === 'string' && isAbsolute(input.path) ? remember(threadId, { path: input.path }) : { unavailable: true } };
    if (input.type === 'image') {
      const remoteImage = typeof input.url === 'string' && input.url.startsWith('data:') ? dataImage(threadId, input.url)
        : typeof input.url === 'string' && /^https?:\/\//.test(input.url) ? { externalUrl: input.url } : { unavailable: true };
      return { type: input.type, remoteImage };
    }
    return input;
  }
  function item(threadId, original) {
    const result = { ...original };
    if (original.type === 'userMessage') { result.content = (original.content || []).map(input => part(threadId,input)); return result; }
    if (original.type === 'agentMessage' && typeof original.text === 'string') {
      // Only explicit Markdown links from Codex can register a local preview.
      // Consume code first so examples are never treated as filesystem access.
      const text = original.text.slice(0,200000).replace(/^ {0,3}(`{3,16}|~{3,16})(?![`~])[^\n]*\n([\s\S]*?)(?:^ {0,3}\1[ \t]*(?:\n|$)|(?![\s\S]))/gm, '\n');
      const tokens = /(`{1,16})(?!`)[^\n]*?\1|!?\[([^\[\]\n]{0,512})\]\((?:<((?:sandbox:)?\/[^<>\n]{1,4096})>|((?:sandbox:)?\/[^\s()]{1,4096}))\)/g;
      const links = [];
      for (const match of text.matchAll(tokens)) {
        if (match[2] === undefined) continue;
        const path = (match[3] || match[4]).replace(/^sandbox:/, '');
        if (path.startsWith('//') || /[\x00-\x1f\x7f]/.test(path) || !/\.(?:png|jpe?g|webp|gif)$/i.test(path)) continue;
        links.push({ markdown: match[0], image: localFiles ? remember(threadId,{path},match[2] || 'image') : {unavailable:true,name:match[2] || 'image'} });
        if (links.length === 16) break;
      }
      if (links.length) result.remoteImageLinks = links;
    }
    const images = []; let visited = 0;
    function scan(value, depth = 0) {
      if (++visited > 1000 || depth > 10 || images.length >= 16) return '[truncated]';
      if (typeof value === 'string') {
        if (value.startsWith('data:image/')) { images.push(dataImage(threadId,value)); return '[image]'; }
        if (/^\s*[\[{]/.test(value) && value.length <= MAX_IMAGE_BYTES * 1.4) {
          try { const parsed = JSON.parse(value); const before = images.length; const clean = scan(parsed,depth+1); return images.length > before ? JSON.stringify(clean) : value; } catch { /* ordinary tool text */ }
        }
        return value;
      }
      if (Array.isArray(value)) return value.map(child => scan(child,depth+1));
      if (!value || typeof value !== 'object') return value;
      if (value.type === 'image' && typeof value.data === 'string' && types[value.mimeType]) { images.push(dataImage(threadId,`data:${value.mimeType};base64,${value.data}`)); return { type: 'image' }; }
      return Object.fromEntries(Object.entries(value).map(([key,child]) => [key,scan(child,depth+1)]));
    }
    if (original.type === 'imageView') {
      images.push(localFiles && isAbsolute(original.path || '') ? remember(threadId,{path:original.path}) : { unavailable:true });
    } else if (original.type === 'imageGeneration') {
      let image;
      if (original.result) {
        let value = original.result;
        if (!value.startsWith('data:') && value.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
          try { value = `data:${imageType(Buffer.from(value, 'base64'))};base64,${value}`; } catch { /* try the saved local file below */ }
        }
        image = /^https?:\/\//.test(value) ? {externalUrl:value} : dataImage(threadId,value);
      }
      if ((!image || image.unavailable) && original.savedPath && localFiles && isAbsolute(original.savedPath)) image = remember(threadId,{path:original.savedPath});
      if (image) images.push(image);
      result.result = original.result ? '[image]' : '';
    } else if (original.type === 'functionCallOutput') result.output = scan(original.output);
    else if (original.type === 'mcpToolCall') result.result = scan(original.result);
    else if (original.type === 'dynamicToolCall') result.contentItems = scan(original.contentItems);
    if (images.length) result.remoteImages = images;
    return result;
  }
  const turn = (id, value) => ({ ...value, items: (value.items || []).map(value => item(id,value)) });
  const queued = (id,value) => ({ ...value, input: (value.input || []).map(value => part(id,value)) });
  function event(message) {
    const p = message.params, id = p?.threadId;
    if (!id || !p.item && !p.turn) return message;
    return { ...message, params: { ...p, ...(p.item ? {item:item(id,p.item)} : {}), ...(p.turn ? {turn:turn(id,p.turn)} : {}) } };
  }
  async function get(threadId, id) {
    const record = records.get(id);
    if (!record || record.threadId !== threadId) throw fail('media.unavailable',404);
    try { return record.source.path ? await readImage(record.source.path) : decode(record.source.data); }
    catch { throw fail('media.unavailable',404); }
  }
  async function upload(threadId, data) {
    const decoded = decode(data.data);
    const name = typeof data.name === 'string' ? data.name.replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,120) : 'image';
    // Serialize quota checks and writes, including requests from multiple tabs.
    const task = writing.catch(()=>{}).then(async () => {
      await mkdir(directory,{recursive:true,mode:0o700});
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw fail('media.storage',503);
      let size = 0;
      for (const file of await readdir(directory)) size += (await stat(resolve(directory,file))).size;
      if (size + decoded.bytes.length > 256 * 1024 * 1024) throw fail('media.storage',507);
      const path = resolve(directory,`${randomBytes(24).toString('hex')}.${types[decoded.mime]}`);
      await writeFile(path,decoded.bytes,{flag:'wx',mode:0o600});
      return remember(threadId,{path},name || 'image');
    });
    writing = task; return task;
  }
  async function input(threadId, ids = []) {
    if (!Array.isArray(ids) || ids.length > MAX_IMAGES || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw fail('media.count');
    return Promise.all(ids.map(async id => { const {bytes,mime} = await get(threadId,id); return {type:'image',url:`data:${mime};base64,${bytes.toString('base64')}`}; }));
  }
  return { upload, input, get, event, turn, queued, item };
}

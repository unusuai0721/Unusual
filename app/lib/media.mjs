import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac', '.flac': 'audio/flac' };
function validImage(buf, ext) {
  if (ext === '.png') return buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (['.jpg', '.jpeg'].includes(ext)) return buf[0] === 255 && buf[1] === 216 && buf[2] === 255;
  if (ext === '.gif') return ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString());
  return ext === '.webp' && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
}
export class Media {
  constructor(store) { this.store = store; this.paths = store.paths; }
  listEmoji = () => {
    if(this.emojiCache && Date.now()-this.emojiCache.at<5000)return structuredClone(this.emojiCache.items);
    const tags = this.store.getMeta('emoji.tags', {});
    const items = fs.readdirSync(this.paths.resolve('data/emoji')).flatMap(name => {
      try {
        const file = this.paths.mediaPath('emoji', name), stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return [];
        return [{ name, tags: Array.isArray(tags[name]) ? tags[name] : [], size: stat.size, url: `/media/emoji/${encodeURIComponent(name)}` }];
      } catch { return []; }
    });
    this.emojiCache={at:Date.now(),items};
    return structuredClone(items);
  };
  upload({ name, data, tags = [] }) {
    const file = this.paths.mediaPath('emoji', name);
    if (typeof data !== 'string' || data.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('表情包需使用有效 Base64 编码，最大 5 MB');
    const buf = Buffer.from(data, 'base64');
    if (buf.length < 12 || buf.length > 5 * 1024 * 1024 || !validImage(buf, path.extname(name).toLowerCase())) throw new Error('文件内容不是对应格式的图片，或大于 5 MB');
    if (fs.existsSync(file)) throw new Error('同名表情包已存在，请重命名后上传');
    this.validateTags(tags);
    fs.writeFileSync(file, buf, { flag: 'wx' });
    this.setTags({ name, tags });
    return { name };
  }
  validateTags(tags) { if (!Array.isArray(tags) || tags.length > 20 || tags.some(t => typeof t !== 'string' || t.length > 40)) throw new Error('标签最多 20 个，每个最多 40 字'); }
  setTags({ name, tags }) {
    if (!fs.existsSync(this.paths.mediaPath('emoji', name))) throw new Error('表情包不存在');
    this.validateTags(tags);
    const all = this.store.getMeta('emoji.tags', {}); all[name] = tags;
    this.emojiCache=null;
    this.store.setMeta('emoji.tags', all); return { name, tags };
  }
  remove(name) { this.emojiCache=null; fs.unlinkSync(this.paths.mediaPath('emoji', name)); const all = this.store.getMeta('emoji.tags', {}); delete all[name]; this.store.setMeta('emoji.tags', all); return { ok: true }; }
  emojiSegment = name => {
    const file = this.paths.mediaPath('emoji', name);
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('表情包过大');
    const buf = fs.readFileSync(file);
    if (!validImage(buf, path.extname(name).toLowerCase())) throw new Error('表情包格式不正确');
    return { type: 'image', data: { file: 'base64://' + buf.toString('base64') } };
  };
  saveAudio = (buffer, extension) => {
    if (!Buffer.isBuffer(buffer) || buffer.length > 20 * 1024 * 1024 || !buffer.length) throw new Error('音频为空或超过 20 MB');
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.${String(extension).replace(/^\./, '')}`;
    fs.writeFileSync(this.paths.mediaPath('audio', name), buffer, { flag: 'wx' });
    return { name, url: '/media/audio/' + encodeURIComponent(name), segment: { type: 'record', data: { file: 'base64://' + buffer.toString('base64') } } };
  };
  read(kind, name) { const file = this.paths.mediaPath(kind, name); if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('媒体文件过大'); return { buffer: fs.readFileSync(file), mime: mime[path.extname(name).toLowerCase()] }; }
  prune() {
    const cutoff = Date.now() - this.store.config.budget.retentionDays * 86400000;
    for (const name of fs.readdirSync(this.paths.resolve('data/audio'))) {
      const file = this.paths.mediaPath('audio', name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  }
}

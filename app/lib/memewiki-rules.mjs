// Adapted from dsh-memewiki 0.1.2, MIT. See licenses/dsh-memewiki.
function 截断(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function 词条文本(row) {
  if (!row) return ''
  const 标题 = String(row.title || '')
  const 用法 = 截断(row.usage, 700)
  const 解释 = 截断(row.summary || row.origin || '', 500)
  const 标签 = 截断(row.tags, 120)
  const lines = [`[梗百科]「${标题}」`]
  if (标签) lines.push(`标签：${标签}`)
  if (用法) lines.push(`怎么用 / 怎么接：\n${用法}`)
  if (解释) lines.push(`出处与含义：\n${解释}`)
  return lines.join('\n')
}

const 问梗模式 = /(?:是)?(?:什么梗|啥梗|什么来头|什么来历|什么出处|什么意思|啥意思|怎么用|怎么接|怎么玩|如何用)(?:啊|呀|呢|的|啊这是)?[？?。！!~～]*$/
const 裸词模式 = /^[\u4e00-\u9fa5A-Za-z0-9·]{2,10}$/

const 无语义词 = new Set([
  '这', '那', '它', '他', '她', '这个', '那个', '你', '这句话', '那句话', '上面', '刚才', '下文', '前面',
])

const 停用词 = new Set([
  '在吗', '在不在', '哈哈', '哈哈哈', '笑死', '好的', '好吧', '晚安', '早安',
  '睡觉', '吃饭', '干嘛', '没事', '收到', '谢谢', '好耶', '草', '典', '乐',
])

// 明显是闲聊/问状态的整句，别当梗去查
const 闲聊短语 = new Set([
  '我是谁', '错了', '情绪', '接下一句', '你也学一个', '今天看什么', '到底多少了',
  '搜出来了吗', '来点贴吧评价', '都是同龄人', '你同事', '道德这么高',
  '这是谁的手臂', '比我能串', '宝宝你醒了', '中国人能不能飞', '你现在什么人格',
])

const 句子成分 = /怎么样|怎么|多少|为什么|能不能|是不是|什么|了吗|了没|一下|你说|要不要|有没有/

const 唤醒词 = ['小鲸鱼', '大鲸鱼', '大肥鲸', '小肥鲸', '大肥鱼', '奶鱼', '鲸鱼', 'deepseek', 'ds']

function 清文本(text) {
  let t = String(text || '').trim()
  t = t.replace(/^(@\S+\s*)+/, '')
  for (const w of 唤醒词) {
    if (t.startsWith(w)) {
      t = t.slice(w.length).trim().replace(/^[，,。.！!？?:：]+|[，,。.！!？?:：]+$/g, '')
      break
    }
  }
  return t.trim()
}

/** 从一句话里提取候选词条；不是问梗就返回 null */
function 提取查询(text) {
  const t = 清文本(text)
  if (!t) return null
  const m = 问梗模式.exec(t)
  if (m) {
    let head = t.slice(0, m.index).replace(/^[ ，,。.！!？?]+|[ ，,。.！!？?]+$/g, '')
    head = head.replace(/^[是]+|[是]+$/g, '').trim()
    head = head.replace(/(这个梗|那个梗|这梗|那梗|这个|那个)$/, '').trim()
    head = head.replace(/(到底|究竟)$/, '').trim()
    if (无语义词.has(head)) return null
    if (head.length <= 2 && '这那它他她'.includes(head[0])) return null
    if (head.length > 1 && head.length <= 12) return head
    return null
  }
  if (裸词模式.test(t) && !停用词.has(t) && !闲聊短语.has(t)) {
    if (句子成分.test(t)) return null
    return t
  }
  return null
}

const 接梗规则 =
  '[梗百科·内置用法]\n' +
  '1. 查到词条就**先接梗、别科普**：照「怎么用/怎么接」回一句，像本来就会；\n' +
  '2. 只有对方明确问「这是什么梗」才解释出处，一两句就够，不要念词条；\n' +
  '3. 查不到就说不知道，别硬编，也别把两个不相干的梗拼一起；\n' +
  '4. 说话用短句，别用客服腔。'

// 串子程度：0 = 很有底线，100 = 放开了串。开关关着时不注入，交给模型自己判断。
function 串子文案(配置) {
  if (!配置.串子开关) return ''
  const 值 = Math.max(0, Math.min(100, Math.round(Number(配置.串子程度) || 0)))
  let 档 = ''
  let 说明 = ''
  if (值 <= 20) {
    档 = '很低'
    说明 = '把对面当真人尊重。可以接正面梗、自嘲、夸人；黑称一律不接、不复读，遇到侮辱性外号直接点一句它为什么不好，不跟着起哄。'
  } else if (值 <= 45) {
    档 = '偏低'
    说明 = '可以损操作、损发挥，不损长相、不损病。别人先用黑称、且明显是玩的时候，跟着接半句；不带头用，不上纲上线。'
  } else if (值 <= 70) {
    档 = '中等'
    说明 = '按社区语境来：别人玩得开的梗就跟着玩，损操作、损战绩、损名言都行；冲家人的词不带头用。'
  } else {
    档 = '很高'
    说明 = '放开串：黑称也照玩（「马头」「四八」这种别人先甩出来的词，接着玩，别扫兴），损操作、损战绩、损长相都接，怎么损怎么来，别端着。只对真事，不自己编新攻击。'
  }
  return `[玩梗尺度·串子程度 ${值}/100（${档}）]\n${说明}\n`
}


export { 提取查询 as extractMemeQuery, 词条文本 as formatMeme, 接梗规则 as memeRules, 串子文案 as memeTone };

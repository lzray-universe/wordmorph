import React, { useEffect, useMemo, useState } from 'react'

type DefineResponse = {
  ok: boolean
  word: string
  source: string
  note?: string
  meaning_or_etym: string | null
  meaning: string | null
  etymology: string | null
  error?: string
  status?: number
}

const WORKER_BASE =
  'https://wordworker.lzraylzraylzray.workers.dev/define?cors=1&word='

const DICTIONARY_API_BASE = 'https://api.dictionaryapi.dev/api/v2/entries/en/'
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODEL = 'openai/gpt-5-nano'
const OPENROUTER_API_KEY =
  (import.meta.env?.VITE_OPENROUTER_API_KEY as string | undefined) || ''
const TRANSLATE_PROMPT_PREFIX =
  '翻译这个单词的解释到中文，你只需给我中文，不要任何其他内容：'
const GLOSBE_WORKER_BASE = 'https://gloworker.lzraylzraylzray.workers.dev/?word='

const MIN_LEN = 3
const MAX_LEN = 14
const ALPHA = 'abcdefghijklmnopqrstuvwxyz'.split('')


function sanitizeWord(w: string) {
  if (!w) return ''
  const s = w.toLowerCase().trim()
  return /^[a-z]+$/.test(s) ? s : ''
}

type DictionaryApiDefinition = {
  definition?: string
}

type DictionaryApiMeaning = {
  partOfSpeech?: string
  definitions?: DictionaryApiDefinition[]
}

type DictionaryApiEntry = {
  meanings?: DictionaryApiMeaning[]
}

function buildFallbackMeaning(entry: DictionaryApiEntry | undefined) {
  if (!entry?.meanings?.length) return null
  const lines: string[] = []
  for (const meaning of entry.meanings) {
    if (!meaning) continue
    const defs = meaning.definitions
      ?.map((d) => d?.definition?.trim())
      .filter(Boolean) as string[]
    if (!defs?.length) continue
    const trimmedPart = meaning.partOfSpeech?.trim()
    const text = defs.slice(0, 2).join(' / ')
    const line = trimmedPart ? `${trimmedPart}: ${text}` : text
    lines.push(line)
    if (lines.length >= 3) break
  }
  if (!lines.length) return null
  return lines.join('\n')
}

async function fetchDictionaryFallback(word: string, signal: AbortSignal) {
  try {
    const url = DICTIONARY_API_BASE + encodeURIComponent(word)
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    const payload = (await res.json()) as DictionaryApiEntry[]
    if (!Array.isArray(payload) || !payload.length) return null
    const english = buildFallbackMeaning(payload[0])
    if (!english) return null
    return {
      english,
      note: '释义补充自 DictionaryAPI.dev',
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') return null
    console.error('Dictionary fallback failed:', err)
    return null
  }
}

type GlosbeWorkerResponse = {
  ok?: boolean
  meaning_or_etym_raw?: string | null
  meanings?: (string | null | undefined)[] | null
  source?: string | null
  note?: string | null
}

function parseGlosbeMeaning(payload: GlosbeWorkerResponse | null | undefined) {
  if (!payload) return null
  const raw = payload.meaning_or_etym_raw?.trim()
  if (raw) {
    return raw.replace(/\s*,\s*/g, '， ')
  }
  const arr = payload.meanings
    ?.map((item) => item?.trim())
    .filter(Boolean) as string[]
  if (arr?.length) {
    return arr.join('； ')
  }
  return null
}

async function fetchGlosbeFallback(word: string, signal: AbortSignal) {
  try {
    const url = GLOSBE_WORKER_BASE + encodeURIComponent(word)
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    const payload = (await res.json()) as GlosbeWorkerResponse
    if (!payload?.ok) return null
    const meaning = parseGlosbeMeaning(payload)
    if (!meaning) return null
    const baseNote = '释义补充自 Glosbe'
    const sourceNote = payload.source?.trim()
      ? `来源：${payload.source.trim()}`
      : null
    return {
      meaning,
      note: mergeNotes(baseNote, payload.note, sourceNote),
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') return null
    console.error('Glosbe fallback failed:', err)
    return null
  }
}

type OpenRouterContentObject = {
  type?: string | null
  text?: string | null
  content?: string | string[] | null
}

type OpenRouterContent = string | OpenRouterContentObject

type OpenRouterChoice = {
  message?: {
    content?: OpenRouterContent | OpenRouterContent[] | null
  } | null
  content?: OpenRouterContent | OpenRouterContent[] | null
}

type OpenRouterResponse = {
  choices?: (OpenRouterChoice | null | undefined)[] | null
}

function normalizeOpenRouterContent(content: unknown): string | null {
  if (!content) return null
  if (typeof content === 'string') return content.trim() || null
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      const normalized = normalizeOpenRouterContent(item)
      if (normalized) parts.push(normalized)
    }
    const joined = parts.join('\n').trim()
    return joined || null
  }
  if (typeof content === 'object') {
    const maybe = content as OpenRouterContentObject
    if (typeof maybe.text === 'string' && maybe.text.trim()) return maybe.text.trim()
    const inner = maybe.content
    if (inner) return normalizeOpenRouterContent(inner)
  }
  return null
}

async function translateEnglishMeaning(
  text: string,
  signal: AbortSignal
): Promise<string | null> {
  if (!text.trim()) return null
  if (!OPENROUTER_API_KEY) {
    console.warn('OpenRouter API key is not configured.')
    return null
  }
  try {
    const res = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'user',
            content: `${TRANSLATE_PROMPT_PREFIX}${text}`,
          },
        ],
      }),
    })
    if (!res.ok) {
      console.error('Meaning translation failed: HTTP', res.status)
      return null
    }
    const data = (await res.json()) as OpenRouterResponse
    const choices = Array.isArray(data?.choices) ? data.choices : []
    for (const choice of choices) {
      if (!choice) continue
      const candidates = [choice.message?.content, choice.content]
      for (const candidate of candidates) {
        const normalized = normalizeOpenRouterContent(candidate)
        if (normalized) return normalized
      }
    }
    return null
  } catch (err: any) {
    if (err?.name === 'AbortError') return null
    console.error('Meaning translation failed:', err)
    return null
  }
}

function mergeNotes(...notes: (string | null | undefined)[]) {
  const filtered = notes.map((n) => n?.trim()).filter(Boolean) as string[]
  if (!filtered.length) return undefined
  return filtered.join('； ')
}

function parseWordlist(text: string) {
  
  const raw = text.replace(/\r/g, '\n').split(/\s+/).map(sanitizeWord).filter(Boolean)
  const byLen = new Map<number, Set<string>>()
  for (const w of raw) {
    if (w.length < MIN_LEN || w.length > MAX_LEN) continue
    if (!byLen.has(w.length)) byLen.set(w.length, new Set())
    byLen.get(w.length)!.add(w)
  }
  return byLen 
}

function buildPatternIndex(words: Set<string> | undefined) {
  
  const index = new Map<string, string[]>()
  if (!words) return index
  for (const w of words) {
    for (let i = 0; i < w.length; i++) {
      const pat = w.slice(0, i) + '*' + w.slice(i + 1)
      const arr = index.get(pat) || []
      arr.push(w)
      index.set(pat, arr)
    }
  }
  return index
}

function subNeighbors(word: string, idx: Map<string, string[]> | undefined) {
  const out = new Set<string>()
  if (!idx) return []
  for (let i = 0; i < word.length; i++) {
    const pat = word.slice(0, i) + '*' + word.slice(i + 1)
    const arr = idx.get(pat)
    if (!arr) continue
    for (const c of arr) if (c !== word) out.add(c)
  }
  return [...out]
}

function insNeighbors(word: string, dictByLen: Map<number, Set<string>>) {
  const L = word.length
  const longer = dictByLen.get(L + 1)
  if (!longer) return []
  const out = new Set<string>()
  for (let i = 0; i <= L; i++) {
    for (const ch of ALPHA) {
      const w2 = word.slice(0, i) + ch + word.slice(i)
      if (longer.has(w2)) out.add(w2)
    }
  }
  return [...out]
}

function delNeighbors(word: string, dictByLen: Map<number, Set<string>>) {
  const L = word.length
  const shorter = dictByLen.get(L - 1)
  if (!shorter) return []
  const out = new Set<string>()
  for (let i = 0; i < L; i++) {
    const w2 = word.slice(0, i) + word.slice(i + 1)
    if (shorter.has(w2)) out.add(w2)
  }
  return [...out]
}


function hLowerBound(a: string, b: string) {

  if (a.length === b.length) {
    let d = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
    return d
  } else {
    return Math.abs(a.length - b.length)
  }
}


function biBFS(
  start: string,
  target: string,
  neighborFn: (w: string) => string[],
  cap: number,
  maxStates = 200000
) {
  if (start === target) return [start]
  const leftPrev = new Map<string, string>()  
  const rightPrev = new Map<string, string>() 
  let left = new Set<string>([start])
  let right = new Set<string>([target])
  const leftDepth = new Map<string, number>([[start, 0]])
  const rightDepth = new Map<string, number>([[target, 0]])
  let expanded = 0

  if (hLowerBound(start, target) > cap) return null

  while (left.size && right.size) {
    const expandLeft = left.size <= right.size
    const frontier = expandLeft ? left : right
    const other = expandLeft ? right : left
    const thisPrev = expandLeft ? leftPrev : rightPrev
    const thisDepth = expandLeft ? leftDepth : rightDepth

    const next = new Set<string>()
    for (const u of frontier) {
      const gu = thisDepth.get(u)!
      for (const v of neighborFn(u)) {
        const gv = gu + 1
        
        const h = expandLeft ? hLowerBound(v, target) : hLowerBound(v, start)
        if (gv + h > cap) continue

        if (!thisDepth.has(v)) {
          thisDepth.set(v, gv)
          thisPrev.set(v, u)
          next.add(v)
          expanded++
          if (expanded > maxStates) {
            throw new Error('SearchExceeded')
          }
          
          if (other.has(v)) {
            const meet = v
            
            const leftPath: string[] = []
            let cur = meet
            while (cur !== start) {
              leftPath.push(cur)
              cur = leftPrev.get(cur)!
            }
            leftPath.push(start)
            leftPath.reverse()
            const rightPath: string[] = []
            cur = meet
            while (cur !== target) {
              const p = rightPrev.get(cur)
              if (!p) break
              rightPath.push(p)
              cur = p
            }
            return [...leftPath, ...rightPath]
          }
        }
      }
    }
    if (expandLeft) left = next
    else right = next
    let minLeft = Infinity
    for (const x of left) minLeft = Math.min(minLeft, leftDepth.get(x)!)
    let minRight = Infinity
    for (const x of right) minRight = Math.min(minRight, rightDepth.get(x)!)
    if (minLeft + minRight > cap) return null
  }
  return null
}


export default function App() {
  const [mode, setMode] = useState<'classic' | 'flex'>('classic')
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem('wordmorph-theme')
      if (stored === 'dark' || stored === 'light') return stored
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
        return 'light'
    }
    return 'dark'
  })
  const [dictByLen, setDictByLen] = useState<Map<number, Set<string>>>(new Map())
  const [patternIndexByLen, setPatternIndexByLen] = useState<
    Map<number, Map<string, string[]>>
  >(new Map())
  const [allowedLens, setAllowedLens] = useState<Set<number>>(new Set([3, 4, 5]))
  const [start, setStart] = useState('')
  const [target, setTarget] = useState('')
  const [gameOn, setGameOn] = useState(false)
  const [path, setPath] = useState<string[]>([])
  const [cap, setCap] = useState(0)
  const [message, setMessage] = useState('')
  const [answer, setAnswer] = useState<string[] | null>(null)
  const [selectedWord, setSelectedWord] = useState<string | null>(null)
  const [lookupData, setLookupData] = useState<DefineResponse | null>(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme)
      document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
    }
    if (typeof window !== 'undefined') window.localStorage.setItem('wordmorph-theme', theme)
  }, [theme])

  function toggleTheme() {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }

  
  useEffect(() => {
    fetch('./wordlist.txt')
      .then((r) => r.text())
      .then((t) => {
        const byLen = parseWordlist(t)
        setDictByLen(byLen)
        setPatternIndexByLen(new Map()) // 懒构建
      })
      .catch(() => {
        setMessage('⚠️ 无法载入词表 wordlist.txt')
      })
  }, [])

  useEffect(() => {
    if (!selectedWord) {
      setLookupData(null)
      setLookupError(null)
      setLookupLoading(false)
      return
    }
    const sanitized = sanitizeWord(selectedWord)
    if (!sanitized) {
      setLookupError('无法查询该词。')
      setLookupLoading(false)
      setLookupData(null)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    async function run() {
      setLookupLoading(true)
      setLookupError(null)
      setLookupData(null)
      try {
        const url = WORKER_BASE + encodeURIComponent(sanitized)
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const payload = (await res.json()) as DefineResponse
        if (!payload.ok)
          throw new Error(
            payload.error || `Lookup failed (status=${payload.status ?? 'unknown'})`
          )
        let finalPayload: DefineResponse = payload
        if (!payload.meaning) {
          const fallback = await fetchDictionaryFallback(sanitized, controller.signal)
          if (fallback) {
            let meaningText = fallback.english
            let fallbackNote = fallback.note
            const translated = await translateEnglishMeaning(
              fallback.english,
              controller.signal
            )
            if (translated) {
              meaningText = `${translated}\n\n(英文释义)\n${fallback.english}`
              fallbackNote = `${fallback.note}（含机器翻译）`
            }
            finalPayload = {
              ...payload,
              meaning: meaningText,
              note: mergeNotes(payload.note, fallbackNote),
            }
          }
        }
        if (!finalPayload.meaning) {
          const glosbe = await fetchGlosbeFallback(sanitized, controller.signal)
          if (glosbe) {
            finalPayload = {
              ...finalPayload,
              meaning: glosbe.meaning,
              note: mergeNotes(finalPayload.note, glosbe.note),
            }
          }
        }
        if (!cancelled) setLookupData(finalPayload)
      } catch (err: any) {
        if (cancelled || err?.name === 'AbortError') return
        setLookupError(err?.message || '查询失败')
      } finally {
        if (!cancelled) setLookupLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [selectedWord])

  const totalWords = useMemo(() => {
    let s = 0
    for (const [, set] of dictByLen) s += set.size
    return s
  }, [dictByLen])

  function ensurePattern(len: number) {
    if (!dictByLen.get(len)) return
    if (patternIndexByLen.get(len)) return
    const idx = buildPatternIndex(dictByLen.get(len))
    const m = new Map(patternIndexByLen)
    m.set(len, idx)
    setPatternIndexByLen(m)
  }

  function pickRandomWord(len: number) {
    const set = dictByLen.get(len)
    if (!set || set.size === 0) return ''
    const idx = Math.floor(Math.random() * set.size)
    let i = 0
    for (const w of set) {
      if (i === idx) return w
      i++
    }
    return ''
  }

  function pickRandomPair() {
    const lens = [...allowedLens].filter((L) => dictByLen.get(L)?.size)
    if (lens.length === 0) {
      setMessage('请先准备 wordlist.txt 或调整允许长度')
      return
    }
    if (mode === 'classic') {
      const L = lens[Math.floor(Math.random() * lens.length)]
      const a = pickRandomWord(L)
      let b = pickRandomWord(L)
      let guard = 0
      while (b === a && guard++ < 50) b = pickRandomWord(L)
      setStart(a)
      setTarget(b)
    } else {
      const L1 = lens[Math.floor(Math.random() * lens.length)]
      const L2 = lens[Math.floor(Math.random() * lens.length)]
      setStart(pickRandomWord(L1))
      setTarget(pickRandomWord(L2))
    }
  }

  function neighborFnFactory(currMode: 'classic' | 'flex') {
    return (w: string) => {
      const L = w.length
      const out = new Set<string>()
      ensurePattern(L)
      const subs = subNeighbors(w, patternIndexByLen.get(L))
      for (const x of subs) out.add(x)
      if (currMode === 'flex') {
        for (const x of insNeighbors(w, dictByLen)) out.add(x)
        for (const x of delNeighbors(w, dictByLen)) out.add(x)
      }
      return [...out]
    }
  }

  function computeMoveCap(a: string, b: string) {
    return a.length === b.length ? 3 * a.length : 3 * Math.max(a.length, b.length)
  }

  function validateStartTarget(a: string, b: string) {
    const sa = sanitizeWord(a)
    const sb = sanitizeWord(b)
    if (!sa || !sb) return '起点/终点应为英文字母（a-z）。'
    if (
      sa.length < MIN_LEN ||
      sa.length > MAX_LEN ||
      sb.length < MIN_LEN ||
      sb.length > MAX_LEN
    )
      return `长度需在${MIN_LEN}-${MAX_LEN}之间。`
    if (!allowedLens.has(sa.length) || !allowedLens.has(sb.length))
      return '起点/终点长度不在允许范围内。'
    const setA = dictByLen.get(sa.length)
    const setB = dictByLen.get(sb.length)
    if (!setA?.has(sa)) return `起点不在词表：${sa}`
    if (!setB?.has(sb)) return `终点不在词表：${sb}`
    if (mode === 'classic' && sa.length !== sb.length) return '经典模式要求首尾长度相同。'
    return ''
  }

  function startGame() {
    const err = validateStartTarget(start, target)
    if (err) {
      setMessage(err)
      return
    }
    setMessage('')
    setAnswer(null)
    setPath([sanitizeWord(start)])
    setCap(computeMoveCap(start, target))
    setGameOn(true)
    setSelectedWord(null)
  }

  function restart() {
    setPath([])
    setGameOn(false)
    setMessage('')
    setAnswer(null)
    setSelectedWord(null)
  }

  function currentWord() {
    return path[path.length - 1] || ''
  }

  function onPlay(next: string) {
    const cur = currentWord()
    const n = sanitizeWord(next)
    if (!n) {
      setMessage('请输入合法的英文单词。')
      return
    }
    if (!allowedLens.has(n.length)) {
      setMessage('该步长度不在允许范围内。')
      return
    }
    const neigh = neighborFnFactory(mode)(cur)
    if (!neigh.includes(n)) {
      setMessage('该步不合法：需要与当前词相差一次允许的操作且在词表内。')
      return
    }
    const newPath = [...path, n]
    if (newPath.length - 1 > cap) {
      setMessage('超出步数上限。')
      return
    }
    setPath(newPath)
    if (n === sanitizeWord(target)) setMessage('✅ 到达终点！')
    else setMessage('')
    setSelectedWord(null)
  }

  function doHint() {
    const cur = currentWord()
    if (!cur) return
    const capHere = cap - (path.length - 1)
    let sp: string[] | null = null
    try {
      sp = biBFS(cur, sanitizeWord(target), neighborFnFactory(mode), capHere)
    } catch (e: any) {
      if (String(e?.message) === 'SearchExceeded') {
        setMessage('提示计算空间过大：请收紧允许长度或选择更接近的词。')
        return
      }
      throw e
    }
    if (!sp) {
      setMessage('未在限定步数内找到最短路。')
      return
    }
    if (sp.length <= 1) {
      setMessage('已在终点。')
      return
    }
    const next = sp[1]
    setMessage(`提示 → ${cur} → ${next}`)
    return next
  }

  function applyHint() {
    const v = doHint()
    if (v) onPlay(v)
  }

  function showAnswer() {
    setMessage('')
    let sp: string[] | null = null
    try {
      sp = biBFS(sanitizeWord(start), sanitizeWord(target), neighborFnFactory(mode), cap)
    } catch (e: any) {
      if (String(e?.message) === 'SearchExceeded') {
        setMessage('搜索空间过大：请收紧允许长度或选择更接近的词。')
        return
      }
      throw e
    }
    if (!sp) {
      setMessage('在当前步数上限内没有找到路径（可能不存在或需要放宽上限/修改允许长度）。')
      return
    }
    setAnswer(sp)
    setMessage(`最短路径长度：${sp.length - 1}`)
  }

  const lensWithCounts = useMemo(() => {
    const arr: { L: number; count: number }[] = []
    for (let L = MIN_LEN; L <= MAX_LEN; L++) {
      arr.push({ L, count: dictByLen.get(L)?.size || 0 })
    }
    return arr
  }, [dictByLen])

  function toggleLen(L: number) {
    const s = new Set(allowedLens)
    if (s.has(L)) s.delete(L)
    else s.add(L)
    setAllowedLens(s)
  }

  const remaining = Math.max(0, cap - (path.length - 1))

  function handleWordClick(w: string) {
    setSelectedWord((prev) => (prev === w ? null : w))
  }

  return (
    <div className="wrap">
      <div className="top-bar">
        <div>
          <h1>Word Morph</h1>
          <div className="muted small tagline">
            固定词表：由 <span className="mono">public/wordlist.txt</span> 提供。
          </div>
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={`切换至${theme === 'dark' ? '日间' : '夜间'}模式`}
        >
          <span className="theme-toggle__icon" aria-hidden="true">
            {theme === 'dark' ? '🌙' : '🌞'}
          </span>
          <span className="theme-toggle__label">{theme === 'dark' ? '夜间模式' : '日间模式'}</span>
        </button>
      </div>

      <div className="grid grid-3" style={{ marginTop: 12 }}>
        <div className="card">
          <h3>① 词表信息</h3>
          <div className="small muted" style={{ marginTop: 6 }}>
            已载入：{totalWords} 个词 · 长度分布
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {lensWithCounts.map(({ L, count }) => {
              const active = allowedLens.has(L)
              return (
                <button
                  key={L}
                  type="button"
                  className={`pill pill-toggle${active ? ' is-active' : ''}`}
                  title="点击切换允许长度"
                  onClick={() => toggleLen(L)}
                  aria-pressed={active}
                >
                  <span className="mono">{L}</span>
                  <span className="muted">{count}</span>
                </button>
              )
            })}
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            点击长度圆片以允许/禁止该长度。
          </div>
        </div>

        <div className="card">
          <h3>② 模式与选词</h3>
          <div className="row" style={{ marginTop: 6 }}>
            <button
              className={'btn ' + (mode === 'classic' ? 'btn-primary' : '')}
              onClick={() => setMode('classic')}
            >
              经典：改 1 字母
            </button>
            <button
              className={'btn ' + (mode === 'flex' ? 'btn-primary' : '')}
              onClick={() => setMode('flex')}
            >
              变种：改/增/删 1 字母
            </button>
          </div>
          <div style={{ marginTop: 8 }} className="small muted">
            经典模式要求首尾长度相同；变种模式可不同长度。
          </div>
          <div style={{ marginTop: 8 }}>
            <label className="small muted">起点</label>
            <input placeholder="例如: cat" value={start} onChange={(e) => setStart(e.target.value)} />
            <label className="small muted" style={{ marginTop: 8, display: 'block' }}>
              终点
            </label>
            <input placeholder="例如: dog" value={target} onChange={(e) => setTarget(e.target.value)} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" onClick={pickRandomPair}>
                随机一对
              </button>
              <button className="btn btn-ok" onClick={startGame}>
                开始
              </button>
              <button className="btn" onClick={restart}>
                重置
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <h3>③ 规则摘要</h3>
          <ul className="small">
            <li>每步后必须是词表中的真实单词。</li>
            <li>经典：一次仅改一个字母（不换位置/顺序）。</li>
            <li>变种：一次可改一个字母，或插入/删除一个字母。</li>
            <li>步数上限：同长 → ≤ 3×长度；异长 → ≤ 3×较长长度。</li>
          </ul>
        </div>
      </div>

      {gameOn && (
        <div className="grid game-grid" style={{ marginTop: 12 }}>
          <div className="card">
            <h3>进行中</h3>
            <div className="row small" style={{ marginTop: 6 }}>
              <span className="pill ok">
                起点：<b className="mono">{sanitizeWord(start)}</b>
              </span>
              <span className="pill end">
                终点：<b className="mono">{sanitizeWord(target)}</b>
              </span>
              <span className="pill">
                已用：<b>{Math.max(0, path.length - 1)}</b>
              </span>
              <span className="pill">
                上限：<b>{cap}</b>
              </span>
              <span className="pill">
                剩余：<b>{remaining}</b>
              </span>
            </div>

            <div style={{ marginTop: 8 }}>
              <div className="small muted">当前词</div>
              <div className="mono pill" style={{ fontSize: 18 }}>
                {path[path.length - 1]}
              </div>
            </div>

            <div className="row" style={{ marginTop: 8 }}>
              <WordInput onSubmit={(w) => onPlay(w)} />
              <button
                className="btn"
                onClick={() => {
                  const v = doHint()
                  return v
                }}
              >
                提示
              </button>
              <button
                className="btn"
                onClick={() => {
                  const v = doHint()
                  if (v) onPlay(v)
                }}
              >
                应用提示
              </button>
              <button className="btn btn-danger" onClick={showAnswer}>
                看答案
              </button>
            </div>

            <div style={{ marginTop: 8 }}>
              <div className="small muted">你的路径</div>
              <div className="row mono">
                {path.map((w, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`pill pill-clickable${selectedWord === w ? ' is-active' : ''}`}
                    onClick={() => handleWordClick(w)}
                    aria-pressed={selectedWord === w}
                    aria-label={`查看 ${w} 的释义与词源`}
                  >
                    {w}
                  </button>
                ))}
              </div>
            </div>

            {answer && (
              <div style={{ marginTop: 12 }}>
                <h4>最短解（示例之一）</h4>
                <div className="row mono">
                  {answer.map((w, i) => (
                    <span key={i} className="pill">
                      {w}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="game-side">
            <div className="card">
              <h3>状态</h3>
              <div className="small" style={{ marginTop: 6 }}>
                {message || '——'}
              </div>
            </div>
            {selectedWord && (
              <WordDetailsCard
                word={selectedWord}
                loading={lookupLoading}
                data={lookupData}
                error={lookupError}
                onClose={() => setSelectedWord(null)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function WordInput({ onSubmit }: { onSubmit: (w: string) => void }) {
  const [v, setV] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(v)
        setV('')
      }}
      className="row"
      style={{ flex: 1 }}
    >
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="输入下一个单词" />
      <button className="btn btn-ok" type="submit">
        提交
      </button>
    </form>
  )
}

function WordDetailsCard({
  word,
  loading,
  data,
  error,
  onClose,
}: {
  word: string
  loading: boolean
  data: DefineResponse | null
  error: string | null
  onClose: () => void
}) {
  return (
    <div className="card word-detail-card">
      <div className="word-detail-header">
        <h3>单词解读</h3>
        <button type="button" className="pill pill-action" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="word-detail-word mono">{word}</div>
      {loading ? (
        <div className="small muted" style={{ marginTop: 8 }}>
          查询中…
        </div>
      ) : error ? (
        <div className="small bad" style={{ marginTop: 8 }}>
          出错了：{error}
        </div>
      ) : data ? (
        <>
          {data.meaning && (
            <section className="word-detail-section">
              <h4>释义</h4>
              <pre className="word-detail-text">{data.meaning}</pre>
            </section>
          )}
          {data.etymology && (
            <section className="word-detail-section">
              <h4>词源</h4>
              <pre className="word-detail-text">{data.etymology}</pre>
            </section>
          )}
          {!data.meaning && !data.etymology && (
            <div className="small muted" style={{ marginTop: 8 }}>
              暂无释义或词源。
            </div>
          )}
        </>
      ) : (
        <div className="small muted" style={{ marginTop: 8 }}>
          暂无数据。
        </div>
      )}
    </div>
  )
}

;(function () {
    'use strict'

    const LOG = '[LyricsTranslation]'
    const SETTINGS_NAME = 'Lyrics Translation'
    const DEFAULT_TARGET_LANG = 'ru'
    let targetLang = DEFAULT_TARGET_LANG
    const MAX_BATCH_CHARS = 4000
    const DEBOUNCE_MS = 200
    const CHUNK_GAP_MS = 80

    const translationCache = new Map()

    let debounceTimer = null
    let batchGeneration = 0
    let lastAppliedSignature = ''
    let pendingSignature = ''

    const LANGUAGE_ALIAS_TO_CODE = {
        auto: 'auto',
        rus: 'ru',
        ru: 'ru',
        eng: 'en',
        en: 'en',
        deu: 'de',
        de: 'de',
        fra: 'fr',
        fr: 'fr',
        ita: 'it',
        it: 'it',
        spa: 'es',
        es: 'es',
        por: 'pt',
        pt: 'pt',
        tr: 'tr',
        tur: 'tr',
        pl: 'pl',
        pol: 'pl',
        ukr: 'uk',
        uk: 'uk',
        be: 'be',
        kaz: 'kk',
        kk: 'kk',
        uz: 'uz',
        ja: 'ja',
        jpn: 'ja',
        ko: 'ko',
        kor: 'ko',
        zh: 'zh-CN',
        'zh-cn': 'zh-CN',
        'zh-tw': 'zh-TW',
        cn: 'zh-CN',
        ar: 'ar',
        hi: 'hi',
        vi: 'vi',
        id: 'id',
        th: 'th',
        nl: 'nl',
        sv: 'sv',
        cs: 'cs',
        ro: 'ro',
        hu: 'hu',
        el: 'el',
    }

    function normalizeTargetLang(raw) {
        const value = String(raw || '')
            .trim()
            .toLowerCase()
            .replace(/_/g, '-')
        if (!value) return DEFAULT_TARGET_LANG
        return LANGUAGE_ALIAS_TO_CODE[value] || value
    }

    function resetTranslationState() {
        translationCache.clear()
        pendingSignature = ''
        lastAppliedSignature = ''
        batchGeneration++
    }

    function debounceProcess() {
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(processAllLines, DEBOUNCE_MS)
    }

    function parseGtxJson(data) {
        try {
            if (!data || !Array.isArray(data[0])) return ''
            return data[0]
                .map(function (part) {
                    return part && part[0] != null ? String(part[0]) : ''
                })
                .join('')
        } catch (e) {
            console.warn(LOG, 'parse error', e)
            return ''
        }
    }

    function extractDetectedLang(data) {
        try {
            if (!data || !Array.isArray(data)) return null
            if (typeof data[2] === 'string') return data[2]
            if (Array.isArray(data[2]) && data[2].length) {
                const x = data[2][0]
                if (typeof x === 'string') return x
                if (Array.isArray(x) && typeof x[0] === 'string') return x[0]
            }
            if (typeof data[8] === 'string') return data[8]
        } catch (e) {}
        return null
    }

    function normalizeLang(code) {
        if (!code) return ''
        const s = String(code).toLowerCase().replace(/_/g, '-')
        const p = s.split('-')
        return p[0] || ''
    }

    async function fetchTranslationBlockMeta(text) {
        const key = text
        if (!key.trim()) {
            return { text: '', sameAsTarget: false, sourceLang: null }
        }
        if (translationCache.has(key)) {
            return translationCache.get(key)
        }

        const url =
            'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
            encodeURIComponent(targetLang) +
            '&dt=t&q=' +
            encodeURIComponent(key)

        const res = await fetch(url)
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const data = await res.json()
        const out = parseGtxJson(data)
        const sourceLang = extractDetectedLang(data)
        const srcNorm = normalizeLang(sourceLang)
        const tgtNorm = normalizeLang(targetLang)
        const sameByApi = Boolean(srcNorm && tgtNorm && srcNorm === tgtNorm)

        const keyNorm = key.replace(/\s+/g, ' ').trim()
        const outNorm = String(out).replace(/\s+/g, ' ').trim()
        const sameByText =
            keyNorm.length >= 12 &&
            outNorm.length >= 12 &&
            keyNorm === outNorm

        const meta = {
            text: out,
            sourceLang: sourceLang,
            sameAsTarget: sameByApi || sameByText,
        }
        translationCache.set(key, meta)
        return meta
    }

    function chunkLineGroups(texts) {
        const groups = []
        let buf = []
        let bufLen = 0

        for (let i = 0; i < texts.length; i++) {
            const line = texts[i]
            const add = line.length + (buf.length ? 1 : 0)
            if (buf.length && bufLen + add > MAX_BATCH_CHARS) {
                groups.push(buf)
                buf = []
                bufLen = 0
            }
            buf.push(line)
            bufLen += add
        }
        if (buf.length) groups.push(buf)
        return groups
    }

    function splitToLineCount(translated, expectedCount) {
        if (expectedCount <= 0) return []
        let parts = String(translated).split(/\r?\n/)

        if (parts.length === expectedCount) return parts

        if (parts.length > expectedCount) {
            const head = parts.slice(0, expectedCount - 1)
            const tail = parts.slice(expectedCount - 1).join(' ')
            return head.concat([tail])
        }

        while (parts.length < expectedCount) {
            parts.push('')
        }
        return parts.slice(0, expectedCount)
    }

    async function translateGroup(lines) {
        if (!lines.length) return { parts: [], skip: false }
        const joined = lines.join('\n')
        const meta = await fetchTranslationBlockMeta(joined)
        if (meta.sameAsTarget) {
            return { parts: [], skip: true }
        }
        return {
            parts: splitToLineCount(meta.text, lines.length),
            skip: false,
        }
    }

    async function translateAllTexts(texts) {
        if (!texts.length) return { parts: [] }
        const groups = chunkLineGroups(texts)
        const result = []
        for (let g = 0; g < groups.length; g++) {
            if (g > 0) {
                await new Promise(function (r) {
                    setTimeout(r, CHUNK_GAP_MS)
                })
            }
            const chunk = groups[g]
            const { parts, skip } = await translateGroup(chunk)
            if (skip) {
                for (let i = 0; i < chunk.length; i++) {
                    result.push(null)
                }
            } else {
                for (let i = 0; i < parts.length; i++) {
                    result.push(parts[i])
                }
            }
        }
        return { parts: result }
    }

    const TRANSLATE_ICON_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_5395_35)"><path d="M12.65 15.67C12.79 15.31 12.7 14.9 12.42 14.62L10.33 12.56L10.36 12.53C12.1 10.59 13.34 8.36 14.07 6H16.01C16.55 6 17 5.55 17 5.01V4.99C17 4.45 16.55 4 16.01 4H10V3C10 2.45 9.55 2 9 2C8.45 2 8 2.45 8 3V4H1.99C1.45 4 1 4.45 1 4.99C1 5.54 1.45 5.98 1.99 5.98H12.17C11.5 7.92 10.44 9.75 9 11.35C8.19 10.46 7.51 9.49 6.94 8.47C6.78 8.18 6.49 8 6.16 8C5.47 8 5.03 8.75 5.37 9.35C6 10.48 6.77 11.56 7.67 12.56L3.3 16.87C2.9 17.26 2.9 17.9 3.3 18.29C3.69 18.68 4.32 18.68 4.72 18.29L9 14L11.02 16.02C11.53 16.53 12.4 16.34 12.65 15.67V15.67ZM17.5 10C16.9 10 16.36 10.37 16.15 10.94L12.48 20.74C12.24 21.35 12.7 22 13.35 22C13.74 22 14.09 21.76 14.23 21.39L15.12 19H19.87L20.77 21.39C20.91 21.75 21.26 22 21.65 22C22.3 22 22.76 21.35 22.53 20.74L18.86 10.94C18.64 10.37 18.1 10 17.5 10V10ZM15.88 17L17.5 12.67L19.12 17H15.88V17Z" fill="white"/></g><defs><clipPath id="clip0_5395_35"><rect width="24" height="24" fill="white"/></clipPath></defs></svg>`;
        

    function getOriginalSpan(lineEl) {
        return lineEl.querySelector(':scope > span:not(.ps-lyrics-tr)')
    }

    function ensureTrSlot(lineEl) {
        let slot = lineEl.querySelector(':scope > span.ps-lyrics-tr')
        if (!slot) {
            slot = document.createElement('span')
            slot.className = 'ps-lyrics-tr'
            slot.setAttribute('aria-hidden', 'true')
            lineEl.appendChild(slot)
        }
        if (!slot.querySelector('.ps-lyrics-tr_text')) {
            slot.innerHTML = ''
            const iconWrap = document.createElement('span')
            iconWrap.className = 'ps-lyrics-tr_icon'
            iconWrap.setAttribute('aria-hidden', 'true')
            iconWrap.innerHTML = TRANSLATE_ICON_SVG
            const textEl = document.createElement('span')
            textEl.className = 'ps-lyrics-tr_text'
            slot.appendChild(iconWrap)
            slot.appendChild(textEl)
        }
        return slot
    }

    function getTrTextEl(slot) {
        return slot.querySelector(':scope > .ps-lyrics-tr_text')
    }

    function clearLineState(lineEl) {
        lineEl.removeAttribute('data-ps-loading')
        lineEl.removeAttribute('data-ps-tr')
        lineEl.removeAttribute('data-ps-src')
        lineEl.removeAttribute('data-ps-skip')
        const tr = lineEl.querySelector(':scope > span.ps-lyrics-tr')
        if (tr) tr.remove()
    }

    function collectLyrics() {
        const nodes = document.querySelectorAll('[data-test-id="SYNC_LYRICS_LINE"]')
        const lineEls = []
        const texts = []

        nodes.forEach(function (lineEl) {
            const orig = getOriginalSpan(lineEl)
            if (!orig) return
            const text = orig.textContent.trim()
            lineEls.push(lineEl)
            texts.push(text)
        })

        return { lineEls: lineEls, texts: texts }
    }

    function makeSignature(texts) {
        return texts.join('\n')
    }

    function processAllLines() {
        const { lineEls, texts } = collectLyrics()
        const sig = makeSignature(texts)

        if (!lineEls.length) {
            lastAppliedSignature = ''
            pendingSignature = ''
            return
        }

        const allRendered =
            sig === lastAppliedSignature &&
            lineEls.every(function (el, i) {
                if (!texts[i]) return true
                return (
                    (el.hasAttribute('data-ps-tr') || el.hasAttribute('data-ps-skip')) &&
                    !el.hasAttribute('data-ps-loading')
                )
            })
        if (allRendered) {
            return
        }

        if (pendingSignature === sig) {
            return
        }

        pendingSignature = sig
        const gen = ++batchGeneration

        lineEls.forEach(function (lineEl, i) {
            if (!texts[i]) {
                clearLineState(lineEl)
            } else {
                lineEl.dataset.psSrc = texts[i]
                lineEl.removeAttribute('data-ps-tr')
                lineEl.removeAttribute('data-ps-skip')
                lineEl.setAttribute('data-ps-loading', '1')
                const slot = ensureTrSlot(lineEl)
                const textEl = getTrTextEl(slot)
                if (textEl) textEl.textContent = ''
                slot.classList.add('ps-lyrics-tr_loading')
            }
        })

        const nonEmptyTexts = texts.filter(function (t) {
            return t.trim().length > 0
        })

        if (!nonEmptyTexts.length) {
            lineEls.forEach(clearLineState)
            lastAppliedSignature = sig
            pendingSignature = ''
            return
        }

        translateAllTexts(texts)
            .then(function (res) {
                if (gen !== batchGeneration) return

                const parts = res.parts
                if (!parts || parts.length !== texts.length) {
                    console.warn(LOG, 'неожиданная длина результата', parts && parts.length, texts.length)
                }

                for (let i = 0; i < lineEls.length; i++) {
                    const lineEl = lineEls[i]
                    if (!lineEl.isConnected) continue

                    const t = texts[i]
                    if (!t) {
                        clearLineState(lineEl)
                        continue
                    }

                    if (parts[i] == null) {
                        clearLineState(lineEl)
                        lineEl.setAttribute('data-ps-skip', '1')
                        continue
                    }

                    const tr = parts[i] != null && String(parts[i]).trim() !== '' ? String(parts[i]) : '—'
                    lineEl.removeAttribute('data-ps-loading')
                    lineEl.removeAttribute('data-ps-skip')
                    lineEl.setAttribute('data-ps-tr', tr)
                    const slot = ensureTrSlot(lineEl)
                    slot.classList.remove('ps-lyrics-tr_loading')
                    const textEl = getTrTextEl(slot)
                    if (textEl) textEl.textContent = tr
                }

                lastAppliedSignature = sig
                pendingSignature = ''
            })
            .catch(function (err) {
                console.warn(LOG, 'batch translate failed', err)
                if (gen !== batchGeneration) return
                pendingSignature = ''
                for (let i = 0; i < lineEls.length; i++) {
                    const lineEl = lineEls[i]
                    if (!lineEl.isConnected || !texts[i]) continue
                    lineEl.removeAttribute('data-ps-loading')
                    lineEl.setAttribute('data-ps-tr', '—')
                    const slot = ensureTrSlot(lineEl)
                    slot.classList.remove('ps-lyrics-tr_loading')
                    const textEl = getTrTextEl(slot)
                    if (textEl) textEl.textContent = '—'
                }
            })
    }

    function transformHandleJSON(data) {
        const result = {}
        if (!data || !Array.isArray(data.sections)) return result
        data.sections.forEach(function (section) {
            if (!section || !Array.isArray(section.items)) return
            section.items.forEach(function (item) {
                if (!item || !item.id) return
                result[item.id] = item
            })
        })
        return result
    }

    function getSelectorEvent(item) {
        if (!item || item.type !== 'selector' || !item.options) return null
        const selectedRaw = item.selected != null ? String(item.selected) : String(item.defaultParameter || '')
        const options = item.options
        if (Array.isArray(options)) {
            const idx = Number(selectedRaw)
            const opt = Number.isFinite(idx) ? options[idx] : null
            return opt && opt.event ? opt.event : null
        }
        const selectedOption = options[selectedRaw]
        if (selectedOption && selectedOption.event) return selectedOption.event
        const byPosition = options[String(Number(selectedRaw))]
        if (byPosition && byPosition.event) return byPosition.event
        return null
    }

    function resolveTargetLangFromSettings(settingsMap) {
        const items = Object.values(settingsMap || {})
        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            if (!item || item.type !== 'selector') continue
            const name = String(item.name || '').toLowerCase()
            if (!name.includes('перевод') && !name.includes('language') && !name.includes('язык')) continue
            const ev = getSelectorEvent(item)
            if (ev) return normalizeTargetLang(ev)
        }
        return targetLang
    }

    async function pollSettings() {
        try {
            const safeName = encodeURIComponent(SETTINGS_NAME)
            const response = await fetch(`http://localhost:2007/get_handle?name=${safeName}`)
            if (!response.ok) return
            const payload = await response.json()
            const settingsMap = transformHandleJSON(payload && payload.data ? payload.data : null)
            const newLang = resolveTargetLangFromSettings(settingsMap)
            if (newLang && newLang !== targetLang) {
                targetLang = newLang
                resetTranslationState()
                processAllLines()
            }
        } catch (e) {}
    }

    const observer = new MutationObserver(function () {
        debounceProcess()
    })

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    })

    processAllLines()
    pollSettings()
    setInterval(pollSettings, 2500)
})()

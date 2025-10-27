// ====================================================================
// content.js  — CSS 핑거프린팅
// - 소스: @media, @container, @supports, @font-face, @import
// - 수정: 실제 URL(@import/url())이 있는 경우에만 규칙을 sink로 간주
// - 수정: 미디어 기능은 선언부가 아니라 @media 조건에서만 읽음
// - 수정: @supports / @container도 선언부가 아닌 조건 텍스트에서만 키워드 검색
// - 연결 정보에는 사이트가 핑거프린팅하려는 대상으로 보이는 항목(의미적 라벨)을 포함
// - 위험 점수(risk scoring)와 전체 위험 수준(riskLevel)을 추가
// ====================================================================

if (window.__cssLoggerInjected) {
  // 이미 주입됨
} else {
  window.__cssLoggerInjected = true;

  const MAX_RULES_PER_SHEET = 1500;
  const URL_SNIPPET_LEN     = 1200;

  // ---------- 헬퍼 ----------
  const short = (s, n = 220) => (s && s.length > n ? s.slice(0, n) + "..." : (s || ""));
  const lower = (s) => (s || "").toLowerCase();

  function getRuleTypeNameByNumber(t) {
    const map = {};
    if (typeof CSSRule !== "undefined") {
      map[CSSRule.STYLE_RULE]       = "CSSStyleRule";
      map[CSSRule.IMPORT_RULE]      = "CSSImportRule";
      map[CSSRule.MEDIA_RULE]       = "CSSMediaRule";
      map[CSSRule.FONT_FACE_RULE]   = "CSSFontFaceRule";
      map[CSSRule.SUPPORTS_RULE]    = "CSSSupportsRule";
      map[CSSRule.PAGE_RULE]        = "CSSPageRule";
      map[CSSRule.KEYFRAMES_RULE]   = "CSSKeyframesRule";  // 소스로는 사용되지 않음
      // CSSContainerRule 열거형은 표준화되어 있지 않으므로 생성자 이름에도 의존
    }
    return map[t] || "CSSRule";
  }
  function ruleTypeName(rule) {
    try {
      if (typeof rule.type === "number") {
        const name = getRuleTypeNameByNumber(rule.type);
        if (name !== "CSSRule") return name;
      }
      return (rule.constructor && rule.constructor.name) || "CSSRule";
    } catch { return "CSSRule"; }
  }
  function getConditionText(rule) {
    try {
      if (rule.conditionText) return rule.conditionText;                 // 일반적으로 @media / @supports
      if (rule.media && rule.media.mediaText) return rule.media.mediaText; // CSSImportRule은 .media를 가짐
    } catch {}
    return "";
  }

  function extractUrlStrings(text) {
    const urls = [];
    if (!text) return urls;
    const urlRegex    = /url\(\s*['"]?([^'")]+)['"]?\s*\)/ig;
    let m;
    while ((m = urlRegex.exec(text)) !== null) urls.push(m[1]);
    return urls;
  }
  function extractImportUrls(text) {
    const urls = [];
    if (!text) return urls;
    const importRegex = /@import\s+(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"])/ig;
    let m;
    while ((m = importRegex.exec(text)) !== null) urls.push(m[1] || m[2]);
    return urls;
  }

  // ---------- 소스 사전(가능한 포괄적) ----------
  // 각 항목: { key, group, claim }
  const MEDIA_SOURCES = [
    // 사용자 선호 / 접근성
    { key: "prefers-color-scheme",   group: "user preference", claim: "color scheme (light/dark)" },
    { key: "prefers-reduced-motion", group: "user preference", claim: "reduced motion preference" },
    { key: "prefers-contrast",       group: "user preference", claim: "contrast preference" },
    { key: "prefers-reduced-data",   group: "user preference", claim: "reduced data preference" },
    { key: "forced-colors",          group: "user preference", claim: "forced colors (OS high contrast)" },

    // 입력 능력
    { key: "hover",        group: "input capability", claim: "hover capability" },
    { key: "any-hover",    group: "input capability", claim: "any-hover capability" },
    { key: "pointer",      group: "input capability", claim: "pointer accuracy" },
    { key: "any-pointer",  group: "input capability", claim: "any-pointer accuracy" },

    // 디스플레이 능력
    { key: "color-gamut",   group: "display capability", claim: "color gamut (sRGB/P3/etc.)" },
    { key: "dynamic-range", group: "display capability", claim: "HDR dynamic range" },
    { key: "monochrome",    group: "display capability", claim: "monochrome bit depth" },
    { key: "resolution",    group: "display capability", claim: "pixel density (dpi/dppx)" },
    { key: "scan",          group: "display capability", claim: "display scan type" },
    { key: "color",         group: "display capability", claim: "device color depth" },     // legacy
    { key: "color-index",   group: "display capability", claim: "color LUT size" },         // legacy

    // 기하 / 방향
    { key: "width",              group: "geometry", claim: "viewport/container width" },
    { key: "height",             group: "geometry", claim: "viewport/container height" },
    { key: "aspect-ratio",       group: "geometry", claim: "viewport aspect ratio" },
    { key: "orientation",        group: "geometry", claim: "screen orientation" },
    { key: "device-width",       group: "geometry", claim: "device width (deprecated)" },
    { key: "device-height",      group: "geometry", claim: "device height (deprecated)" },
    { key: "device-aspect-ratio",group: "geometry", claim: "device aspect ratio (deprecated)" },

    // 앱 / 환경
    { key: "display-mode",         group: "app environment", claim: "PWA display mode" },
    { key: "environment-blending", group: "app environment", claim: "environment blending mode" },

    // UA 동작
    { key: "scripting",       group: "ua behavior", claim: "scripting support" },
    { key: "update",          group: "ua behavior", claim: "update frequency" },
    { key: "overflow-block",  group: "ua behavior", claim: "block overflow behavior" },
    { key: "overflow-inline", group: "ua behavior", claim: "inline overflow behavior" },

    // 미디어 타입
    { key: "screen", group: "media type", claim: "screen media" },
    { key: "print",  group: "media type", claim: "print media" },
    { key: "speech", group: "media type", claim: "speech media" }
  ];

  const SUPPORTS_SOURCES = [
    // 레이아웃 / 최신 CSS
    { key: "container-type",        group: "layout capability", claim: "container queries support (type)" },
    { key: "container-name",        group: "layout capability", claim: "container queries support (name)" },
    { key: "content-visibility",    group: "layout capability", claim: "content-visibility support" },
    { key: "contain",               group: "layout capability", claim: "CSS contain support" },
    { key: "aspect-ratio",          group: "layout capability", claim: "aspect-ratio property support" },
    { key: "text-wrap",             group: "layout capability", claim: "text-wrap support" },
    { key: "text-box",              group: "layout capability", claim: "text-box properties support" },
    { key: "anchor-name",           group: "layout capability", claim: "anchor positioning support" },

    // 선택자 기능
    { key: "selector(:has",         group: "selector capability", claim: ":has() selector support" },

    // 그래픽 / 시각 효과
    { key: "backdrop-filter",       group: "graphics pipeline", claim: "backdrop-filter support" },
    { key: "clip-path",             group: "graphics pipeline", claim: "clip-path support" },
    { key: "mask-image",            group: "graphics pipeline", claim: "mask-image support" },
    { key: "mask-border",           group: "graphics pipeline", claim: "mask-border support" },
    { key: "shape-outside",         group: "graphics pipeline", claim: "shape-outside support" },
    { key: "filter",                group: "graphics pipeline", claim: "CSS filter support" },

    // 타임라인(소스 전용)
    { key: "animation-timeline",    group: "timeline capability", claim: "animation timeline support" },
    { key: "view-timeline",         group: "timeline capability", claim: "view timeline support" },
    { key: "timeline-scope",        group: "timeline capability", claim: "timeline scope support" },

    // 폰트 / 색상
    { key: "font-variation-settings", group: "font capability",  claim: "variable font support" },
    { key: "font-format(",            group: "font capability",  claim: "font format query support" },
    { key: "font-tech(",              group: "font capability",  claim: "font tech query support" },
    { key: "color(display-p3",        group: "color capability", claim: "display-p3 color function support" },
    { key: "accent-color",            group: "form styling",     claim: "accent-color support" },

    // 스크롤바
    { key: "scrollbar-gutter",      group: "engine feature", claim: "scrollbar-gutter support" },
    { key: "scrollbar-width",       group: "engine feature", claim: "scrollbar-width support" },
    { key: "scrollbar-color",       group: "engine feature", claim: "scrollbar-color support" },

    // 엔진 힌트
    { key: "-webkit-appearance",    group: "engine hint",    claim: "WebKit-specific appearance" },
    { key: "-moz-appearance",       group: "engine hint",    claim: "Gecko-specific appearance" }
  ];

  const CONTAINER_SOURCES = [
    { key: "@container",     group: "container query", claim: "container query present" },
    { key: "container-type", group: "container query", claim: "container-type used" },
    { key: "container-name", group: "container query", claim: "container-name used" },
    { key: "inline-size",    group: "container query", claim: "inline-size query" },
    { key: "block-size",     group: "container query", claim: "block-size query" },
    { key: "style(",         group: "container query", claim: "style() query" }
  ];

  // @font-face를 소스로 간주(로컬 탐지 + 포맷 지원)
  const FONTFACE_SOURCES = [
    { key: "local(",             group: "fonts", claim: "local font presence probe" },
    { key: "format('woff2')",    group: "fonts", claim: "font format support (woff2)" },
    { key: "format(\"woff2\")",  group: "fonts", claim: "font format support (woff2)" },
    { key: "format('woff')",     group: "fonts", claim: "font format support (woff)" },
    { key: "format(\"woff\")",   group: "fonts", claim: "font format support (woff)" },
    { key: "format('opentype')", group: "fonts", claim: "font format support (opentype)" },
    { key: "format(\"opentype\")", group: "fonts", claim: "font format support (opentype)" },
    { key: "format('truetype')", group: "fonts", claim: "font format support (truetype)" },
    { key: "format(\"truetype\")", group: "fonts", claim: "font format support (truetype)" },
    { key: "format('embedded-opentype')", group: "fonts", claim: "font format support (eot)" },
    { key: "format(\"embedded-opentype\")", group: "fonts", claim: "font format support (eot)" },
    { key: "format('svg')",      group: "fonts", claim: "font format support (svg)" },
    { key: "format(\"svg\")",    group: "fonts", claim: "font format support (svg)" }
  ];

  // @import는 미디어 조건이 있을 때 소스로 계산
  const IMPORT_MEDIA_KEYS = MEDIA_SOURCES.map(m => m.key);

  // ---------- 위험 점수 ----------
  function riskFor(semanticGroup, keyword, claim) {
    switch (semanticGroup) {
      case "fonts":              return /local\(/.test(keyword || "") ? 4 : 3; // local() > format
      case "user preference":    return 3;
      case "font capability":    return 3;
      case "display capability": return 2;
      case "input capability":   return 2;
      case "layout capability":  return 2;
      case "selector capability":return 2;
      case "graphics pipeline":  return 2;
      case "timeline capability":return 2;
      case "container query":    return 2;
      case "import condition":   return 2;
      case "engine feature":     return 1;
      case "engine hint":        return 1;
      case "app environment":    return 1;
      case "ua behavior":        return 1;
      case "media type":         return 1;
      case "geometry":           return 1;
      case "color capability":   return 2;
      case "form styling":       return 1;
      default:                   return 1;
    }
  }
  function explanationFor(semanticGroup, keyword, claim) {
    // 각 그룹별 설명 문자열 생성(동작 설명용)
    switch (semanticGroup) {
      case "fonts":
        if (/local\(/.test(keyword || "")) return "Indicates whether a specific system font is installed.";
        return "Indicates which downloadable font formats the engine supports.";
      case "user preference":
        if (keyword === "forced-colors") return "Reveals OS high-contrast accessibility mode.";
        if (keyword === "prefers-color-scheme") return "Reveals light vs dark theme preference.";
        if (keyword === "prefers-reduced-motion") return "Reveals motion sensitivity preference.";
        return "Reveals OS/user accessibility or UI preferences.";
      case "display capability":
        return "Reveals screen/output characteristics like color space or pixel density.";
      case "geometry":
        return "Reveals viewport/device size buckets.";
      case "input capability":
        return "Reveals touch vs mouse and pointer precision.";
      case "layout capability":
        return "Reveals support for modern layout features; implies engine/version.";
      case "selector capability":
        return "Reveals support for newer selectors; implies engine/version.";
      case "graphics pipeline":
        return "Reveals graphics effects support; implies engine/version.";
      case "timeline capability":
        return "Reveals scroll/animation timeline support; implies engine/version.";
      case "container query":
        return "Uses container size/style to branch; layout-dependent signal.";
      case "import condition":
        return "Conditionally loads a stylesheet only when the media condition matches.";
      default:
        return `Reveals ${claim || keyword || semanticGroup}`;
    }
  }

  // ---------- sinks ----------
  // 실제 URL을 추출할 수 있을 때만 sink로 간주
  function collectSinkUrls(cssText, typeName) {
    const urls = [];
    const text = lower(cssText || "");
    urls.push(...extractUrlStrings(text));
    urls.push(...extractImportUrls(text));
    // 파싱된 URL 문자열이 없어도 CSSImportRule이면 sink 표시를 남김
    if (typeName === "CSSImportRule" && urls.length === 0) urls.push("(import)");
    return urls;
  }

  // ---------- 규칙 내 소스 식별 ----------
  // 반환: { category, keyword, semanticGroup, claim, excerpt } 배열
  function identifySourceKeywords(rule) {
    const out = [];
    try {
      const type    = ruleTypeName(rule);
      const cssText = lower(rule.cssText || "");
      const cond    = lower(getConditionText(rule) || "");

      // @media — 선언부가 아닌 @media 조건 텍스트만 검사
      if (type === "CSSMediaRule" || /@media\b/i.test(cssText)) {
        for (const m of MEDIA_SOURCES) {
          if (cond.includes(m.key)) {
            out.push({ category: "@media", keyword: m.key, semanticGroup: m.group, claim: m.claim, excerpt: short(cond, 200) });
          }
        }
      }

      // @container — 조건 텍스트만 검사 (선언부는 검사하지 않음)
      const isContainer =
        (type.toLowerCase().includes("container") || cssText.includes("@container"));
      if (isContainer) {
        const hay = cond; // 조건 텍스트만 사용
        if (hay) {
          for (const c of CONTAINER_SOURCES) {
            if (hay.includes(c.key)) {
              out.push({ category: "@container", keyword: c.key, semanticGroup: c.group, claim: c.claim, excerpt: short(hay, 200) });
            }
          }
        }
      }

      // @supports — 조건 텍스트만 검사 (선언부는 검사하지 않음)
      if (type === "CSSSupportsRule" || /@supports\b/i.test(cssText)) {
        const hay = cond; // 조건 텍스트만 사용
        if (hay) {
          for (const s of SUPPORTS_SOURCES) {
            if (hay.includes(s.key)) {
              out.push({ category: "@supports", keyword: s.key, semanticGroup: s.group, claim: s.claim, excerpt: short(hay, 200) });
            }
          }
        }
      }

      // @font-face (선언부 검사)
      if (type === "CSSFontFaceRule" || /@font-face\b/i.test(cssText)) {
        for (const f of FONTFACE_SOURCES) {
          if (cssText.includes(f.key)) {
            out.push({ category: "@font-face", keyword: f.key, semanticGroup: f.group, claim: f.claim, excerpt: short(cssText, 200) });
          }
        }
      }

      // @import — 미디어 조건이 있을 때만 소스로 계산(mediaText가 소스)
      if (type === "CSSImportRule" || /@import\b/i.test(cssText)) {
        let mediaTxt = "";
        try { if (rule.media && rule.media.mediaText) mediaTxt = lower(rule.media.mediaText || ""); } catch {}
        const hay = mediaTxt || "";
        for (const key of IMPORT_MEDIA_KEYS) {
          if (hay.includes(key)) {
            out.push({ category: "@import", keyword: key, semanticGroup: "import condition", claim: `conditional import via ${key}`, excerpt: short(hay, 200) });
          }
        }
      }

    } catch {}
    // category+keyword 기준으로 중복 제거
    const seen = new Set();
    return out.filter(x => {
      const id = x.category + "::" + x.keyword;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  // ---------- 규칙 순회 ----------
  function walkRulesToList(rules, sheetHref, groupContext, outList) {
    if (!rules) return;
    outList = outList || [];
    for (let i = 0; i < rules.length; i++) {
      if (outList.length >= MAX_RULES_PER_SHEET) break;

      const rule      = rules[i];
      const type      = ruleTypeName(rule);
      const selector  = ("selectorText" in rule && rule.selectorText) ? rule.selectorText : "";
      const cssText   = rule.cssText || "";
      const groupCond = getConditionText(rule);

      const entry = {
        type,
        selector,
        cssText: short(cssText, URL_SNIPPET_LEN),
        urls: [],            // sink 수집 후 설정
        group: groupContext || groupCond || "",
        sources: [],
        sinks: []
      };

      // 소스
      const srcs = identifySourceKeywords(rule);
      if (srcs.length) {
        entry.sources = srcs.map(s => ({
          reason: "keyword_match",
          category: s.category,
          keyword: s.keyword,
          semanticGroup: s.semanticGroup,
          claim: s.claim,
          excerpt: s.excerpt
        }));
      }

      // sinks(실제 URL이 있을 때만)
      const sinkUrls = collectSinkUrls(cssText, type);
      if (sinkUrls.length > 0) {
        entry.urls = sinkUrls.slice();
        entry.sinks.push({ reason: "url_sink", urls: sinkUrls.slice() });
      }

      outList.push(entry);

      // 중첩 규칙
      try {
        if (rule.cssRules && rule.cssRules.length) {
          walkRulesToList(rule.cssRules, sheetHref, groupCond || groupContext || "", outList);
        }
      } catch {
        // 교차 출처/접근 불가 중첩 규칙
      }
    }
    return outList;
  }

  // ---------- 메인 ----------
  (function run() {
    const dump = {
      page: location.href,
      timestamp: Date.now(),
      sheets: [],
      inaccessible: []
    };

    for (let s = 0; s < document.styleSheets.length; s++) {
      const sheet = document.styleSheets[s];
      const rec = { href: sheet.href || "(inline <style>)", rules: 0, rulesList: [] };
      try {
        if (sheet.cssRules) {
          rec.rulesList = walkRulesToList(sheet.cssRules, rec.href, "", []);
          rec.rules = rec.rulesList.length;
        } else {
          rec.rules = 0;
        }
      } catch (e) {
        rec.rules = "inaccessible";
        dump.inaccessible.push(sheet.href || "(inline)");
      }
      dump.sheets.push(rec);
    }

    dump.styleTags        = document.querySelectorAll("style").length;
    dump.inlineStyleCount = document.querySelectorAll("[style]").length;

    // 연결 정보와 주장(claims) 구성
    dump.associations = [];
    const claimSet = new Set();
    const claimDetailsMap = new Map(); // key -> 상세 객체

    for (const sheetRec of dump.sheets) {
      const list = sheetRec.rulesList || [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r.sinks || !r.sinks.length) continue;

        const sinkUrls = (r.sinks[0].urls && r.sinks[0].urls.length)
          ? r.sinks[0].urls
          : [];

        for (const url of sinkUrls) {
          const assoc = { sheet: sheetRec.href, sinkRuleIndex: i, sinkUrl: url, matchedSources: [] };

          // 동일 규칙에 소스가 있으면 첨부
          if (r.sources && r.sources.length) {
            for (const s of r.sources) {
              assoc.matchedSources.push({
                ruleIndex: i,
                reason: "same-rule",
                category: s.category,
                keyword: s.keyword,
                claim: s.claim,
                semanticGroup: s.semanticGroup,
                excerpt: s.excerpt
              });
              const key = `${s.semanticGroup}|${s.claim}|${s.keyword}`;
              if (!claimDetailsMap.has(key)) {
                claimDetailsMap.set(key, {
                  category: s.category,
                  semanticGroup: s.semanticGroup,
                  keyword: s.keyword,
                  claim: s.claim,
                  risk: riskFor(s.semanticGroup, s.keyword, s.claim),
                  explanation: explanationFor(s.semanticGroup, s.keyword, s.claim)
                });
              }
              claimSet.add(`${s.semanticGroup}: ${s.claim}`);
            }
          }

          // 동일 선택자에 소스가 있는 다른 규칙을 탐색
          if (!assoc.matchedSources.length && r.selector) {
            for (let j = 0; j < list.length; j++) {
              if (j === i) continue;
              const r2 = list[j];
              if (r2.selector && r2.selector === r.selector && r2.sources && r2.sources.length) {
                for (const s2 of r2.sources) {
                  assoc.matchedSources.push({
                    ruleIndex: j,
                    reason: "same-selector",
                    category: s2.category,
                    keyword: s2.keyword,
                    claim: s2.claim,
                    semanticGroup: s2.semanticGroup,
                    excerpt: s2.excerpt
                  });
                  const key = `${s2.semanticGroup}|${s2.claim}|${s2.keyword}`;
                  if (!claimDetailsMap.has(key)) {
                    claimDetailsMap.set(key, {
                      category: s2.category,
                      semanticGroup: s2.semanticGroup,
                      keyword: s2.keyword,
                      claim: s2.claim,
                      risk: riskFor(s2.semanticGroup, s2.keyword, s2.claim),
                      explanation: explanationFor(s2.semanticGroup, s2.keyword, s2.claim)
                    });
                  }
                  claimSet.add(`${s2.semanticGroup}: ${s2.claim}`);
                }
              }
            }
          }

          // 동일 그룹 텍스트(@media/@supports/@container/@import)가 있는 다른 규칙을 탐색
          if (!assoc.matchedSources.length && r.group) {
            for (let j = 0; j < list.length; j++) {
              if (j === i) continue;
              const r3 = list[j];
              if (r3.group && r3.group === r.group && r3.sources && r3.sources.length) {
                for (const s3 of r3.sources) {
                  assoc.matchedSources.push({
                    ruleIndex: j,
                    reason: "same-group",
                    category: s3.category,
                    keyword: s3.keyword,
                    claim: s3.claim,
                    semanticGroup: s3.semanticGroup,
                    excerpt: s3.excerpt
                  });
                  const key = `${s3.semanticGroup}|${s3.claim}|${s3.keyword}`;
                  if (!claimDetailsMap.has(key)) {
                    claimDetailsMap.set(key, {
                      category: s3.category,
                      semanticGroup: s3.semanticGroup,
                      keyword: s3.keyword,
                      claim: s3.claim,
                      risk: riskFor(s3.semanticGroup, s3.keyword, s3.claim),
                      explanation: explanationFor(s3.semanticGroup, s3.keyword, s3.claim)
                    });
                  }
                  claimSet.add(`${s3.semanticGroup}: ${s3.claim}`);
                }
              }
            }
          }

          dump.associations.push(assoc);
        }
      }
    }

    // 요약 + 판정 + 위험
    dump.summary = {
      sheetsAccessible: dump.sheets.filter(s => s.rules !== "inaccessible").length,
      sheetsInaccessible: dump.inaccessible.length,
      totalRulesScanned: dump.sheets.reduce((acc, s) => acc + (Array.isArray(s.rulesList) ? s.rulesList.length : 0), 0),
      totalSinks: dump.sheets.reduce((acc, s) => acc + (Array.isArray(s.rulesList)
        ? s.rulesList.reduce((a, r) => a + (r.sinks ? r.sinks.length : 0), 0) : 0), 0),
      totalSources: dump.sheets.reduce((acc, s) => acc + (Array.isArray(s.rulesList)
        ? s.rulesList.reduce((a, r) => a + (r.sources ? r.sources.length : 0), 0) : 0), 0),
      totalAssociations: dump.associations.length
    };

    const hasLinked = dump.associations.some(a => a.matchedSources && a.matchedSources.length);
    dump.likelyFingerprinting = !!hasLinked;
    dump.verdict = hasLinked ? "likely fingerprinting" : "likely not fingerprinting";

    // 문자열 기반 claims(하위 호환용)
    dump.claims = Array.from(new Set(
      Array.from((function*(){
        for (const a of dump.associations) {
          if (!a.matchedSources) continue;
          for (const s of a.matchedSources) yield `${s.semanticGroup}: ${s.claim}`;
        }
      })())
    )).sort();

    // 상세 claims(위험 + 설명 포함)
    dump.claimDetails = (function(){
      const map = new Map();
      for (const a of dump.associations) {
        if (!a.matchedSources) continue;
        for (const s of a.matchedSources) {
          const key = `${s.semanticGroup}|${s.claim}|${s.keyword}`;
          if (!map.has(key)) {
            map.set(key, {
              category: s.category,
              semanticGroup: s.semanticGroup,
              keyword: s.keyword,
              claim: s.claim,
              risk: riskFor(s.semanticGroup, s.keyword, s.claim),
              explanation: explanationFor(s.semanticGroup, s.keyword, s.claim)
            });
          }
        }
      }
      return Array.from(map.values()).sort((a, b) => b.risk - a.risk || (a.claim || "").localeCompare(b.claim || ""));
    })();

    // 전체 위험 수준
    const totalRisk = dump.claimDetails.reduce((acc, c) => acc + (c.risk || 0), 0);
    dump.riskScore = totalRisk;
    dump.riskLevel = !hasLinked ? "none"
                     : totalRisk >= 7 ? "high"
                     : totalRisk >= 3 ? "medium" : "low";

    // 저장 + 전송
    window.__lastCssDump = dump;
    try {
      chrome.runtime.sendMessage({ type: "cssDump", payload: dump }, function () {});
    } catch (e) {
      console.warn("chrome.runtime.sendMessage failed:", e);
      console.log("dump:", dump);
    }
  })();
}

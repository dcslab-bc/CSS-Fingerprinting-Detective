// 이미 주입된 적이 있는지 확인하여, 중복 실행을 막음
if (window.__cssLoggerInjected) {
  console.log("Already injected");
} else {
  // 주입 플래그 설정
  window.__cssLoggerInjected = true;

  // 수집 한도를 정해 DevTools/메모리 과부하 방지
  const MAX_RULES_PER_SHEET = 800;  // 스타일시트 1개당 최대 수집할 규칙 수
  const URL_SNIPPET_LEN     = 800;  // 규칙의 cssText를 저장할 때 잘라낼 최대 길이
  // 보조 함수들
  // CSSRule.type(숫자) → 읽기 쉬운 이름으로 변환
  function getRuleTypeNameByNumber(t) {
    const map = {};
    if (typeof CSSRule !== "undefined") {
      map[CSSRule.STYLE_RULE]     = "CSSStyleRule";     // 일반 선택자 규칙
      map[CSSRule.IMPORT_RULE]    = "CSSImportRule";    // @import
      map[CSSRule.MEDIA_RULE]     = "CSSMediaRule";     // @media
      map[CSSRule.FONT_FACE_RULE] = "CSSFontFaceRule";  // @font-face
      map[CSSRule.SUPPORTS_RULE]  = "CSSSupportsRule";  // @supports
      // @container는 표준 상수가 없는 브라우저가 있어서 아래 constructor.name로 식별
    }
    return map[t] || "CSSRule";
  }

  // 규칙 객체에서 타입 이름을 안전하게 얻음(숫자 타입 우선, 없으면 constructor.name)
  function ruleTypeName(rule) {
    try {
      if (typeof rule.type === "number") {
        const name = getRuleTypeNameByNumber(rule.type);
        if (name !== "CSSRule") return name;
      }
      return (rule.constructor && rule.constructor.name) || "CSSRule";
    } catch (e) {
      return "CSSRule";
    }
  }

  // 긴 문자열을 콘솔/저장에 적당한 길이로 축약
  function short(s, n) {
    if (!s) return "";
    n = n || 200;
    return s.length > n ? s.slice(0, n) + "..." : s;
  }

  // cssText 안에서 url(...) / @import 경로를 뽑아냄 → 네트워크로 나가는 후보(=sink) 탐지에 사용
  function extractUrlsFromText(text) {
    const urls = [];
    if (!text) return urls;

    // background-image: url("...") 등
    const urlRegex    = /url\(\s*['"]?([^'")]+)['"]?\s*\)/ig;
    // @import url("...") 또는 @import "..."
    const importRegex = /@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/ig;

    let m;
    while ((m = urlRegex.exec(text))    !== null) urls.push(m[1]);
    while ((m = importRegex.exec(text)) !== null) urls.push(m[1] || m[2]);
    return urls;
  }

  // 휴리스틱: Source / Sink 후보 판별
  //  - Source: 환경/렌더링 차이를 드러내는 신호(폰트, @media, @supports, @container, 특정 UI요소 등)
  //  - Sink  : 네트워크 요청이나 외부 리소스 로드 등 관찰 가능한 행동(url, @import, 숨김 로딩 패턴 등)
  
  function isLikelySource(typeName, cssText, selector) {
    const text = (cssText || "").toLowerCase();
    const sel  = (selector || "").toLowerCase();

    // 폰트는 플랫폼/설치 상태에 따라 달라져 지문 신호가 됨
    if (typeName === "CSSFontFaceRule") return true;
    if (text.indexOf("font-family") !== -1) return true;

    // 그룹 규칙은 환경(화면/지원 기능/컨테이너 크기)에 의존 → 지문 조건으로 쓰일 수 있음
    if (typeName === "CSSMediaRule" || typeName === "CSSSupportsRule") return true;
    if (typeName.indexOf("Container") !== -1) return true; // CSSContainerRule 대응

    // 입력/버튼 등 렌더링 차이가 큰 요소를 직접 타겟팅하는 규칙
    if (/(^|[^a-z])(textarea|input|select|button)([^a-z]|$)/.test(sel)) return true;

    return false;
  }

  function isLikelySink(typeName, cssText, selector) {
    const text = (cssText || "").toLowerCase();
    const sel  = (selector || "").toLowerCase();

    // @import는 외부 CSS를 불러옴 → 네트워크 요청
    if (typeName === "CSSImportRule") return true;

    // url(...) 사용은 대체로 외부 리소스 요청(이미지, 폰트 등)
    if (text.indexOf("url(") !== -1 || text.indexOf("@import") !== -1) return true;

    // 배경 크기를 0 또는 투명도로 만들어 "보이지 않게 로딩"하는 패턴
    if (text.indexOf("background-size: 0") !== -1 || text.indexOf("opacity: 0") !== -1) return true;

    // 방문 상태/호버 등 의사 클래스 기반 신호(행동/상태를 엿볼 수 있는 경우)
    if (/:(?:visited|hover|active)|::selection/.test(sel)) return true;

    return false;
  }

  // 결과를 담을 컨테이너(dump)
  
  const dump = {
    page: location.href,      // 현재 페이지 URL
    timestamp: Date.now(),    // 수집 시각
    sheets: [],               // 스타일시트별 수집 결과
    inaccessible: []          // CORS 등으로 접근 불가한 스타일시트 목록
  };

  // @media/@supports/@container 등의 조건 텍스트를 안전하게 얻음
  function getConditionText(rule) {
    try {
      if (rule.conditionText) return rule.conditionText;
      if (rule.media && rule.media.mediaText) return rule.media.mediaText;
    } catch (e) {}
    return "";
  }

  // 규칙 목록을 재귀적으로 순회하며 직렬화된 형태로 outList에 누적
  function walkRulesToList(rules, sheetHref, groupContext, outList) {
    if (!rules) return;
    groupContext = groupContext || "";
    outList      = outList || [];

    for (var idx = 0; idx < rules.length; idx++) {
      // 너무 많은 규칙을 수집하는 것을 방지
      if (outList.length >= MAX_RULES_PER_SHEET) break;

      var rule      = rules[idx];
      var type      = ruleTypeName(rule);                                         // 규칙 타입명(안전)
      var selector  = ("selectorText" in rule && rule.selectorText) ? rule.selectorText : ""; // 선택자(없을 수 있음)
      var cssText   = rule.cssText || "";                                         // 규칙 전체 텍스트
      var thisGroup = getConditionText(rule);                                     // 현재 규칙의 그룹 조건(@media 등)

      // 규칙을 직렬화하여 보관
      var entry = {
        type: type,
        selector: selector,
        cssText: short(cssText, URL_SNIPPET_LEN),
        urls: extractUrlsFromText(cssText),               // url(...) 등에서 추출된 경로
        group: groupContext || thisGroup || "",           // 상위 그룹과 현재 그룹을 병합
        sources: [],                                      // Source 후보 설명
        sinks: []                                         // Sink 후보 설명
      };

      // Source/Sink 휴리스틱 적용
      if (isLikelySource(type, cssText, selector)) {
        entry.sources.push({ reason: "heuristic_source", excerpt: short(cssText, 200) });
      }
      if (isLikelySink(type, cssText, selector)) {
        entry.sinks.push({ reason: "heuristic_sink", urls: entry.urls.slice() });
      }

      outList.push(entry);

      // @media/@supports/@container 내부에 중첩된 하위 규칙이 있으면 재귀 순회
      try {
        if (rule.cssRules && rule.cssRules.length) {
          var nestedGroup = thisGroup || entry.group || "";
          walkRulesToList(rule.cssRules, sheetHref, nestedGroup, outList);
        }
      } catch (e) {
        // 일부 브라우저/정책에서 그룹 내부 접근이 막힐 수 있음 → 무시하고 계속
      }
    }
    return outList;
  }


  // 문서 내 모든 스타일시트(document.styleSheets) 순회
  //  - 접근 가능한 경우 cssRules를 읽어 walkRulesToList로 수집
  //  - 크로스 오리진 등으로 접근 불가하면 목록에 기록
  
  for (var s = 0; s < document.styleSheets.length; s++) {
    var sheet    = document.styleSheets[s];
    var sheetRec = { href: sheet.href || "(inline <style>)", rules: 0, rulesList: [] };

    try {
      var rules = sheet.cssRules; // CORS로 막히면 여기서 예외 발생
      if (rules) {
        var list = walkRulesToList(rules, sheetRec.href, "", []);
        sheetRec.rules     = list.length;
        sheetRec.rulesList = list;
      } else {
        sheetRec.rules = 0;
      }
    } catch (e) {
      sheetRec.rules     = "inaccessible";
      sheetRec.rulesList = [];
      dump.inaccessible.push(sheet.href || "(inline)");
    }
    dump.sheets.push(sheetRec);
  }

  // 간단한 통계: <style> 태그 갯수, 인라인 style 속성 갯수
  dump.styleTags        = document.querySelectorAll("style").length;
  dump.inlineStyleCount = document.querySelectorAll("[style]").length;

  // Source ↔ Sink 연관(association) 만들기
  //  - 같은 규칙 / 같은 선택자 / 같은 그룹(@media/@supports/@container) 기준으로 연결
  //  - 목적: “이 소스 조건이 켜지면 이 URL이 로드된다”의 단서를 찾기 위함
  
  dump.associations = [];
  for (var si = 0; si < dump.sheets.length; si++) {
    var sheetRec  = dump.sheets[si];
    var rulesList = sheetRec.rulesList || [];

    for (var i = 0; i < rulesList.length; i++) {
      var r = rulesList[i];
      if (!r.sinks || !r.sinks.length) continue;

      // sink URL 후보: 규칙 자체 url 목록 → sink 객체의 urls 순으로 우선
      var sinkUrls = (r.sinks[0].urls && r.sinks[0].urls.length)
        ? r.sinks[0].urls
        : (r.urls && r.urls.length ? r.urls : []);

      for (var u = 0; u < sinkUrls.length; u++) {
        var url   = sinkUrls[u];
        var assoc = { sheet: sheetRec.href, sinkRuleIndex: i, sinkUrl: url, matchedSources: [] };

        // 1) 같은 규칙 안에 source가 있는 경우
        if (r.sources && r.sources.length) {
          for (var k = 0; k < r.sources.length; k++) {
            assoc.matchedSources.push({ ruleIndex: i, reason: r.sources[k].reason || "same-rule", matchType: "same-rule" });
          }
        }

        // 2) 같은 선택자(selector)가 다른 규칙에 존재하는 경우
        if (!assoc.matchedSources.length && r.selector) {
          for (var j = 0; j < rulesList.length; j++) {
            if (j === i) continue;
            var r2 = rulesList[j];
            if (r2.selector && r2.selector === r.selector && r2.sources && r2.sources.length) {
              for (var k2 = 0; k2 < r2.sources.length; k2++) {
                assoc.matchedSources.push({ ruleIndex: j, reason: r2.sources[k2].reason || "same-selector", matchType: "same-selector" });
              }
            }
          }
        }

        // 3) 같은 그룹(@media/@supports/@container)에 속한 경우
        if (!assoc.matchedSources.length && r.group) {
          for (var j2 = 0; j2 < rulesList.length; j2++) {
            if (j2 === i) continue;
            var r3 = rulesList[j2];
            if (r3.group && r3.group === r.group && r3.sources && r3.sources.length) {
              for (var k3 = 0; k3 < r3.sources.length; k3++) {
                assoc.matchedSources.push({ ruleIndex: j2, reason: r3.sources[k3].reason || "same-group", matchType: "same-group" });
              }
            }
          }
        }

        dump.associations.push(assoc);
      }
    }
  }

  // 최종 요약 통계(콘솔에서 빠르게 확인하려고 계산함)
  dump.summary = {
    sheetsAccessible: dump.sheets.filter(s => s.rules !== "inaccessible").length,
    sheetsInaccessible: dump.inaccessible.length,
    totalRulesScanned: dump.sheets.reduce(function (acc, s) {
      return acc + (Array.isArray(s.rulesList) ? s.rulesList.length : 0);
    }, 0),
    totalSinks: dump.sheets.reduce(function (acc, s) {
      return acc + (Array.isArray(s.rulesList)
        ? s.rulesList.reduce((a, r) => a + (r.sinks ? r.sinks.length : 0), 0)
        : 0);
    }, 0),
    totalSources: dump.sheets.reduce(function (acc, s) {
      return acc + (Array.isArray(s.rulesList)
        ? s.rulesList.reduce((a, r) => a + (r.sources ? r.sources.length : 0), 0)
        : 0);
    }, 0),
    totalAssociations: dump.associations.length
  };

  // 요약/접근불가 목록을 콘솔에 출력
  console.log("CSS dump summary:", dump.summary);
  console.table(dump.sheets.map(function (s) { return { href: s.href, rules: s.rules }; }));
  if (dump.inaccessible.length) console.warn("Inaccessible stylesheets:", dump.inaccessible);

  // background 서비스워커로 결과 전송(백그라운드에서 파일 저장/서버 전송 등 처리)
  try {
    chrome.runtime.sendMessage({ type: "cssDump", payload: dump }, function (resp) {});
  } catch (e) {
    // 확장 환경이 아니거나 메시지 채널 이슈시 콘솔에 직접 남김
    console.warn("chrome.runtime.sendMessage 실패:", e);
    console.log("dump:", dump);
  }
}

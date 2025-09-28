// 사용자가 확장 프로그램 아이콘을 클릭했을 때 실행되는 핸들러
// 현재 탭(tab)에 content.js를 주입하여 페이지 안에서 CSS 수집을 수행하게 함
chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({
    target: { tabId: tab.id }, // 주입 대상 탭
    files: ["content.js"]      // 주입할 스크립트
  });
});

// content.js가 보낸 메시지를 수신하는 리스너
// 메시지 타입이 "cssDump"인 경우에만 처리(그 외 메시지는 무시)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "cssDump" || !message.payload) {
    return; // 처리 대상 아님 → 조용히 종료
  }

  // content.js가 만든 전체 덤프(수집 결과)
  const dump = message.payload;

  // 파일 이름(ISO 타임스탬프 기반) 구성: 운영체제에서 파일명으로 쓸 수 있게 콜론/점 제거
  const iso = new Date(dump.timestamp).toISOString().replace(/[:.]/g, "-");
  const filename = `css_dump_${iso}.json`;

  // 1) 다운로드: MV3 서비스 워커 환경에서 안정적인 data: URL 방식을 사용
  //    - Blob + createObjectURL도 가능하지만, 워커 라이프사이클/권한 문제로 실패할 수 있어 data: 권장
  try {
    // JSON 문자열 생성(가독성을 위해 들여쓰기 2칸)
    const json = JSON.stringify(dump, null, 2);

    // data URL 형태로 인코딩
    const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);

    // chrome.downloads API로 사용자의 다운로드 폴더에 저장
    chrome.downloads.download(
      {
        url: dataUrl,               // 저장할 데이터
        filename,                   // 저장 파일명
        conflictAction: "uniquify", // 같은 이름 존재 시 자동으로 (1), (2) 붙이기
        saveAs: false               // 저장 대화상자 표시 안 함(자동 저장)
      },
      (downloadId) => {
        // API 호출 후 오류가 있으면 runtime.lastError에 담김
        const err = chrome.runtime.lastError;
        if (err) {
          console.warn("[downloads] 실패:", err.message);
        } else {
          console.log("[downloads] 시작됨 id=", downloadId);
        }
      }
    );
  } catch (e) {
    console.warn("다운로드 처리 중 예외:", e);
  }

  // 2) 로컬 저장: chrome.storage.local에 동일한 데이터를 한 번 더 저장(선택 사항)
  //    - 나중에 팝업/옵션 페이지에서 목록화하거나 재분석할 때 사용 가능
  try {
    const key = `css_dump_${dump.timestamp}`;
    chrome.storage.local.set({ [key]: dump }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn("[storage] 저장 실패:", err.message);
      } else {
        console.log("[storage] 저장 완료 key=", key);
      }
    });
  } catch (e) {
    console.warn("storage 저장 중 예외:", e);
  }

  // 호출 쪽(content.js)으로 간단한 응답 반환(성공/파일명)
  // sendResponse는 선택적이며, 여기서는 비동기 작업을 기다릴 필요가 없으므로 false 반환
  try {
    sendResponse({ status: "ok", savedAs: filename });
  } catch (_) {}
  return false;
});

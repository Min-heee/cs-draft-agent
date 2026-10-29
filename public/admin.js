// 관리자 화면의 실시간 부분. 3초마다 /api/live에서 새 알림을 받아
// 화면 알림(오른쪽 아래), 맥 알림, 소리, 사이드바 개수, 탭 제목, 문의함 목록을 바꾼다.
// 고객이 쓴 글이 들어 있을 수 있으므로 알림 문구는 모두 textContent로 넣는다.
(() => {
  const body = document.body;
  const page = body.dataset.page;
  const item = body.dataset.item;
  const itemStatus = body.dataset.status;
  const baseTitle = body.dataset.title || document.title;
  let lastId = Number(body.dataset.lastId || 0);
  /** 서버 DB를 새로 만들면 바뀐다. 바뀌면 서버가 알림을 처음부터 다시 준다. */
  let dbId = body.dataset.db || "";
  let draftDirty = false;
  /** 마지막으로 본 개수. 알림 없이 개수만 바뀌어도(다른 직원이 처리 등) 목록을 다시 받는다. 처음 값은 화면을 그릴 때의 개수다. */
  let lastSignature = body.dataset.signature || null;

  const $ = (id) => document.getElementById(id);
  const bell = $("bell");
  const panel = $("bell-panel");
  const feed = $("feed");
  const toasts = $("toasts");
  const sound = $("sound");
  const soundHint = $("sound-hint");
  const osEnable = $("os-enable");
  const osState = $("os-state");

  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* 저장이 막혀 있어도 화면은 그대로 동작한다 */ }
    },
  };

  // 승인 전에 초안을 고치고 있으면, 그 글에 새 알림이 와도 화면을 다시 불러오지 않는다.
  const answer = document.querySelector("#review-form textarea");
  if (answer) answer.addEventListener("input", () => { draftDirty = true; });

  function setCount(key, n) {
    for (const el of document.querySelectorAll(`[data-count="${key}"]`)) {
      el.textContent = String(n);
      el.toggleAttribute("data-zero", n === 0);
    }
  }

  function setUnread(n) {
    setCount("unread", n);
    document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
  }

  const timeText = (iso) =>
    new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function feedItem(n) {
    const li = document.createElement("li");
    li.className = `${n.read_at ? "read" : "unread"} type-${n.type}`;
    const a = document.createElement("a");
    a.href = n.link;
    const dot = document.createElement("span");
    dot.className = "n-dot";
    dot.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "n-text";
    text.textContent = n.message;
    const time = document.createElement("time");
    time.textContent = timeText(n.created_at);
    a.append(dot, text, time);
    li.append(a);
    return li;
  }

  function addToFeed(n) {
    if (!feed) return;
    feed.querySelector(".empty-feed")?.remove();
    feed.prepend(feedItem(n));
    while (feed.children.length > 15) feed.lastElementChild.remove();
  }

  const HINT = {
    arrived: "초안을 만들고 있습니다",
    drafted: "검토하고 승인하면 등록됩니다",
    needs_human: "담당자 확인이 필요한 초안입니다",
    draft_failed: "다시 만들기를 눌러 주세요",
    posted: "카페24에 등록했습니다",
    post_failed: "처리 완료 탭에서 다시 등록해 주세요",
    sync_failed: "카페24 연결을 확인해 주세요",
    complaint_rise: "불만 사유 리포트에서 확인해 주세요",
  };

  // 불만 사유 탭: '지금 만들기'가 끝나면(만드는 중 → 끝) 다시 읽어 새 순위를 보여 준다.
  let complaintsWereRunning = null;
  function watchComplaints(data) {
    if (page !== "complaints" || typeof data.complaintsRunning !== "boolean") return;
    if (complaintsWereRunning === true && data.complaintsRunning === false) location.reload();
    complaintsWereRunning = data.complaintsRunning;
  }

  function toast(n) {
    if (!toasts) return;
    const a = document.createElement("a");
    a.className = `toast type-${n.type}`;
    a.href = n.link;
    const dot = document.createElement("span");
    dot.className = "n-dot";
    dot.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "n-text";
    text.textContent = n.message;
    const hint = document.createElement("small");
    hint.textContent = n.hint ?? HINT[n.type] ?? "";
    text.append(hint);
    a.append(dot, text);
    toasts.append(a);
    while (toasts.children.length > 4) toasts.firstElementChild.remove();
    setTimeout(() => a.remove(), 8000);
  }

  function osNotify(n) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    // 화면을 보고 있으면 화면 알림으로 충분하다.
    if (!document.hidden && document.hasFocus()) return;
    try {
      const shown = new Notification(n.message, { body: n.link === "/notifications" ? "" : HINT[n.type] || "", tag: `cs-${n.id}` });
      shown.onclick = () => {
        window.focus();
        location.href = n.link;
      };
    } catch { /* 알림을 못 띄우는 환경이면 화면 알림만 쓴다 */ }
  }

  // 브라우저는 사용자가 화면을 누르거나 키를 누르기 전에는 소리를 막는다.
  // 페이지마다 소리 장치를 새로 만들어야 해서, 누를 때마다 준비를 시도하고 소리가 켜지면 그만한다.
  // (터치의 pointerdown이나 Esc 키는 브라우저가 "사용자 동작"으로 치지 않을 수 있어 한 번만 듣지 않는다.)
  let audio = null;
  const UNLOCK_EVENTS = ["click", "touchend", "keydown"];
  function readyAudio() {
    try {
      audio ??= new AudioContext();
      if (audio.state !== "running") void audio.resume().then(renderSound, renderSound);
    } catch { /* 소리를 못 내는 환경 */ }
    renderSound();
  }
  function renderSound() {
    if (audio?.state === "running") for (const type of UNLOCK_EVENTS) document.removeEventListener(type, readyAudio, true);
    if (!soundHint) return;
    soundHint.hidden = !sound?.checked || audio?.state === "running";
  }
  for (const type of UNLOCK_EVENTS) document.addEventListener(type, readyAudio, true);

  function beep() {
    if (!sound?.checked) return;
    readyAudio();
    if (!audio || audio.state !== "running") return;
    try {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.15, audio.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.4);
    } catch { /* 브라우저가 소리를 막으면 조용히 넘어간다 */ }
  }

  function renderWatch(watch) {
    const el = $("watch");
    const text = $("watch-text");
    if (!el || !text || !watch) return;
    el.className = `watch ${watch.tone}`;
    text.textContent = watch.text;
  }

  async function refreshList() {
    const list = $("list");
    if (!list) return;
    const url = new URL(location.href);
    url.searchParams.delete("msg");
    url.searchParams.set("fragment", "1");
    try {
      const res = await fetch(url, { headers: { Accept: "text/html" } });
      if (!res.ok) return;
      // 목록을 바꿔 끼우면 키보드로 고르던 줄의 포커스가 사라지므로, 같은 글로 다시 옮긴다.
      const focused = list.contains(document.activeElement) ? document.activeElement.getAttribute("href") : null;
      list.innerHTML = await res.text(); // 서버가 이스케이프해서 그린 HTML
      if (focused) list.querySelector(`a[href="${CSS.escape(focused)}"]`)?.focus();
    } catch { /* 다음 확인 때 다시 받는다 */ }
  }

  const DRAFT_DONE = new Set(["drafted", "needs_human", "draft_failed"]);

  function announce(notifications) {
    for (const n of notifications) addToFeed(n);
    // 이미 읽음인 알림(직접 누른 등록 완료 등)은 목록과 화면 알림에만 남기고 소리·맥 알림은 내지 않는다.
    const fresh = notifications.filter((n) => !n.read_at);
    // 한꺼번에 많이 오면(서버를 켠 직후 등) 마지막 몇 건만 띄우고 나머지는 한 줄로 묶는다.
    const shown = notifications.slice(-3);
    const rest = notifications.length - shown.length;
    if (rest > 0) toast({ type: "arrived", message: `새 알림 ${rest}건 더`, hint: "알림 전체 보기에서 볼 수 있습니다", link: "/notifications" });
    for (const n of shown) toast(n);
    if (fresh.length > 1) osNotify({ id: `sum-${lastId}`, type: "arrived", message: `새 알림 ${fresh.length}건`, link: "/notifications" });
    else if (fresh.length === 1) osNotify(fresh[0]);
    if (fresh.length) beep();
  }

  async function poll() {
    try {
      const res = await fetch(`/api/live?after=${lastId}&db=${encodeURIComponent(dbId)}`, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const live = await res.json();
        for (const [key, n] of Object.entries(live.counts)) setCount(key, n);
        setUnread(live.unread);
        renderWatch(live.watch);
        // 서버 DB를 새로 만들었으면(reset) 번호가 처음부터 다시 시작한다. 그때 온 알림도 똑같이 보여 준다.
        lastId = live.lastId;
        dbId = live.dbId;
        if (live.notifications.length) announce(live.notifications);
        watchComplaints(live);
        const signature = JSON.stringify([live.counts, live.unread]);
        if (page === "inbox" && (live.notifications.length || signature !== lastSignature)) {
          await refreshList();
        }
        lastSignature = signature;
        const mine = live.notifications.some((n) => String(n.article_no) === item && DRAFT_DONE.has(n.type));
        if (page === "detail" && mine && (itemStatus === "new" || itemStatus === "drafting") && !draftDirty) location.reload();
      }
    } catch { /* 서버가 잠깐 꺼져도 계속 확인한다 */ }
    setTimeout(poll, 3000);
  }

  // 뒤로 가기로 돌아온 화면(브라우저가 저장해 둔 화면)은 목록과 읽음 표시가 옛것이라 새로 불러온다.
  // 고치던 초안이 있으면 다시 불러오지 않는다(고친 내용이 사라질 수 있다). 개수와 알림은 다음 확인 때 맞춰진다.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && !draftDirty) location.reload();
  });

  // 종 모양 버튼: 알림 목록 열고 닫기
  function setPanel(open) {
    if (!bell || !panel) return;
    // 좁은 화면에서는 목록을 화면에 고정하므로, 종 모양 버튼 바로 아래에 오도록 위치를 잡는다.
    if (open && window.matchMedia("(max-width: 900px)").matches) {
      const top = Math.round(bell.getBoundingClientRect().bottom + 8);
      panel.style.top = `${top}px`;
      // 화면 높이가 낮아도 목록 끝("알림 전체 보기")까지 스크롤할 수 있게 남은 높이에 맞춘다.
      panel.style.maxHeight = `calc(100dvh - ${top + 12}px)`;
    } else {
      panel.style.top = "";
      panel.style.maxHeight = "";
    }
    panel.hidden = !open;
    bell.setAttribute("aria-expanded", String(open));
  }
  bell?.addEventListener("click", (e) => {
    e.stopPropagation();
    setPanel(panel.hidden);
  });
  document.addEventListener("click", (e) => {
    if (panel && !panel.hidden && !panel.contains(e.target)) setPanel(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel && !panel.hidden) {
      setPanel(false);
      bell.focus();
    }
  });

  $("mark-all")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/notifications/read", { method: "POST", headers: { Accept: "application/json" } });
      if (!res.ok) return;
      setUnread(0);
      // 종 모양 목록과 알림 화면의 목록 모두
      for (const li of document.querySelectorAll(".feed .unread")) li.className = li.className.replace("unread", "read");
      for (const dot of document.querySelectorAll(".new-dot")) {
        dot.nextElementSibling?.classList.contains("sr-only") && dot.nextElementSibling.remove();
        dot.remove();
      }
    } catch { /* 다음에 다시 누르면 된다 */ }
  });

  // 소리: 기본으로 켜 두고, 끄면 기억한다.
  if (sound) {
    sound.checked = store.get("cs-sound") !== "off";
    sound.addEventListener("change", () => {
      store.set("cs-sound", sound.checked ? "on" : "off");
      renderSound();
    });
  }
  renderSound();

  // 맥 알림: 브라우저가 한 번 허락을 받아야 한다.
  function renderOs() {
    if (!osEnable || !osState) return;
    if (!("Notification" in window)) {
      osEnable.hidden = true;
      osState.textContent = "이 브라우저는 알림을 지원하지 않습니다";
      return;
    }
    osEnable.hidden = Notification.permission !== "default";
    osState.textContent =
      Notification.permission === "granted" ? "맥 알림 켜짐" : Notification.permission === "denied" ? "맥 알림 꺼짐(브라우저 설정)" : "";
  }
  osEnable?.addEventListener("click", async () => {
    try { await Notification.requestPermission(); } catch { /* 이전 방식 브라우저 */ }
    renderOs();
  });
  renderOs();

  setUnread(Number(document.querySelector('.badge[data-count="unread"]')?.textContent || 0));
  setTimeout(poll, 3000);
})();

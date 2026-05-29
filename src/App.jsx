import React, { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_BASE_URL = "https://signal-telegram-server.onrender.com";
const STORAGE_KEY = "signal-position-archives-v2";

const resultOptions = ["수익 🟢", "손절 🔴", "본절 ⚪", "미진입", "진행중"];

const initialSignals = [];
const initialBlocked = [];

const orderNames = [
  "첫번째",
  "두번째",
  "세번째",
  "네번째",
  "다섯번째",
  "여섯번째",
  "일곱번째",
  "여덟번째",
  "아홉번째",
  "열번째",
];

function getTodayText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

function getTimeText() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
}

function clonePositions(positions) {
  return positions.map((position) => ({ ...position }));
}

function makePositionDraft() {
  return [
    { round: "1차", result: "수익 🟢", amount: "" },
    { round: "2차", result: "미진입", amount: "" },
    { round: "3차", result: "미진입", amount: "" },
  ];
}

function makeDefaultPositions() {
  return [
    { round: "1차", result: "진행중", amount: "" },
    { round: "2차", result: "미진입", amount: "" },
    { round: "3차", result: "미진입", amount: "" },
  ];
}

function normalizeServerSignal(item) {
  const orderText =
    item.orderText ||
    `${orderNames[item.order - 1] || `${item.order}번째`} 시그널`;

  return {
    id: item.id,
    order: orderText,
    startTime: item.startedAt || "-",
    endTime: item.endedAt || (item.status === "종료" ? "-" : "진행중"),
    result: item.status === "종료" ? "결과 입력 필요" : "확인중",
    status: item.status || "진행중",
    positions: makeDefaultPositions(),
  };
}

function formatNumber(value) {
  if (value === "" || value === null || Number.isNaN(Number(value))) return "-";
  return Number(value).toFixed(1);
}

function sanitizeAmount(value) {
  const cleaned = value.replace(/[^\d.]/g, "");
  const parts = cleaned.split(".");

  if (parts.length <= 1) return cleaned;

  return `${parts[0]}.${parts.slice(1).join("")}`;
}

function formatMoney(amount) {
  const value = String(amount).trim();

  if (value === "") return "";

  return `+$${value}`;
}

function calculateTp({ direction, baseEntry, entry2, entry3, tpGap }) {
  const base = Number(baseEntry);
  const e2 = Number(entry2);
  const e3 = Number(entry3);
  const gap = Number(tpGap);
  const sign = direction === "LONG" ? 1 : -1;

  const secondAverage =
    Number.isFinite(base) && Number.isFinite(e2)
      ? (base * 2 + e2) / 3
      : null;

  const thirdAverage =
    Number.isFinite(base) && Number.isFinite(e2) && Number.isFinite(e3)
      ? (base * 2 + e2 + e3) / 4
      : null;

  return {
    secondAverage,
    secondTp:
      secondAverage !== null && Number.isFinite(gap)
        ? secondAverage + sign * gap
        : null,
    thirdAverage,
    thirdTp:
      thirdAverage !== null && Number.isFinite(gap)
        ? thirdAverage + sign * gap
        : null,
  };
}

function makePositionText(signals, tradeDate, tradeSymbol) {
  if (signals.length === 0) {
    return "";
  }

  const body = signals
    .map((item) => {
      const positionLines = item.positions
        .map((position) => {
          if (position.result === "미진입") {
            return `${position.round} ${tradeSymbol} 미진입`;
          }

          if (position.amount.trim() === "") {
            return `${position.round} ${tradeSymbol} ${position.result}`;
          }

          return `${position.round} ${tradeSymbol} ${
            position.result
          }: ${formatMoney(position.amount)}`;
        })
        .join("\n");

      return `${item.order}\n${positionLines}`;
    })
    .join("\n\n");

  return `[${tradeDate} ${tradeSymbol}] 거래 결과\n\n${body}\n\n금일 매매결과 정리본 입니다`;
}

function toDateText(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getWeekKey(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;

  date.setDate(date.getDate() + diff);

  return toDateText(date);
}

function formatShortDate(dateText) {
  const [, month, day] = dateText.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function formatShortRange(startDate, endDate) {
  if (!startDate || !endDate) return "저장 기록 없음";
  if (startDate === endDate) return formatShortDate(startDate);
  return `${formatShortDate(startDate)} ~ ${formatShortDate(endDate)}`;
}

function enrichArchive(group) {
  const records = [...group.records].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const startDate = records[0]?.date || "";
  const endDate = records[records.length - 1]?.date || "";
  const updatedAt = records.reduce(
    (latest, record) => (record.updatedAt > latest ? record.updatedAt : latest),
    ""
  );

  return { ...group, records, startDate, endDate, updatedAt };
}

function loadArchives() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) return [];

    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(enrichArchive)
      .sort((a, b) => b.weekKey.localeCompare(a.weekKey))
      .slice(0, 2);
  } catch (error) {
    return [];
  }
}

function upsertArchive(prevArchives, dailyRecord) {
  const weekKey = getWeekKey(dailyRecord.date);

  const archiveMap = new Map(
    prevArchives.map((archive) => [
      archive.weekKey,
      { ...archive, records: [...archive.records] },
    ])
  );

  const target = archiveMap.get(weekKey) || { weekKey, records: [] };

  const recordIndex = target.records.findIndex(
    (record) =>
      record.date === dailyRecord.date && record.symbol === dailyRecord.symbol
  );

  if (recordIndex >= 0) {
    target.records[recordIndex] = dailyRecord;
  } else {
    target.records.push(dailyRecord);
  }

  archiveMap.set(weekKey, target);

  return Array.from(archiveMap.values())
    .map(enrichArchive)
    .sort((a, b) => b.weekKey.localeCompare(a.weekKey))
    .slice(0, 2);
}

function makeArchiveText(archive) {
  if (!archive) return "저장된 포지션 기록이 없습니다.";

  const range = formatShortRange(archive.startDate, archive.endDate);
  const body = archive.records
    .map((record) => `────────────\n${record.text}`)
    .join("\n\n");

  return `[${range} 포지션 기록]\n\n${body}`;
}

export default function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [signals, setSignals] = useState(initialSignals);
  const [blockedSignals, setBlockedSignals] = useState(initialBlocked);

  const [copied, setCopied] = useState(false);
  const [calcCopied, setCalcCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [archiveCopied, setArchiveCopied] = useState(false);

  const [serverStatus, setServerStatus] = useState(null);
  const [serverLoading, setServerLoading] = useState(false);

  const [tradeDate, setTradeDate] = useState(getTodayText());
  const [tradeSymbol, setTradeSymbol] = useState("XAUUSD");
  const [direction, setDirection] = useState("LONG");
  const [tpGap, setTpGap] = useState("10");
  const [baseEntry, setBaseEntry] = useState("4000");
  const [entry2, setEntry2] = useState("3990");
  const [entry3, setEntry3] = useState("3980");

  const [selectedSignalId, setSelectedSignalId] = useState("");
  const [positionDraft, setPositionDraft] = useState(() => makePositionDraft());

  const [archives, setArchives] = useState(() => loadArchives());
  const [selectedArchiveKey, setSelectedArchiveKey] = useState("");

  const currentSignal = signals.find((item) => item.status === "진행중");
  const selectedSignal = signals.find(
    (item) => item.id === Number(selectedSignalId)
  );

  const selectedArchive =
    archives.find((archive) => archive.weekKey === selectedArchiveKey) ||
    archives[0];

  const serverActiveSignal = serverStatus?.activeSignal;
  const isSignalRunning = Boolean(serverStatus?.signalRunning || isRunning);

  const positionText = useMemo(
    () => makePositionText(signals, tradeDate, tradeSymbol),
    [signals, tradeDate, tradeSymbol]
  );

  const archiveText = useMemo(
    () => makeArchiveText(selectedArchive),
    [selectedArchive]
  );

  const calc = useMemo(
    () => calculateTp({ direction, baseEntry, entry2, entry3, tpGap }),
    [direction, baseEntry, entry2, entry3, tpGap]
  );

  const calcText = useMemo(() => {
    const directionText = direction === "LONG" ? "롱" : "숏";

    return `[${tradeSymbol} ${directionText} TP 계산]

기준 진입가: ${baseEntry}

2차 진입가: ${entry2}
2차 평균가: ${formatNumber(calc.secondAverage)}
2차 TP: ${formatNumber(calc.secondTp)}

3차 진입가: ${entry3}
3차 평균가: ${formatNumber(calc.thirdAverage)}
3차 TP: ${formatNumber(calc.thirdTp)}`;
  }, [tradeSymbol, direction, baseEntry, entry2, entry3, calc]);

  const fetchServerStatus = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/status`);
      const data = await response.json();
      setServerStatus(data);
    } catch (error) {
      console.error("서버 상태 불러오기 실패:", error);
      setServerStatus(null);
    }
  };

  const postServerAction = async (path) => {
    try {
      setServerLoading(true);

      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: "POST",
      });

      const data = await response.json();

      await fetchServerStatus();

      return data;
    } catch (error) {
      alert("서버 연결에 실패했어요. Render 서버가 켜져 있는지 확인해주세요!");
      console.error(error);
      return null;
    } finally {
      setServerLoading(false);
    }
  };

  const deleteServerItem = async (path, message) => {
    const ok = window.confirm(message);

    if (!ok) return;

    try {
      setServerLoading(true);

      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!data.ok) {
        alert(data.error || "삭제에 실패했어요.");
        return;
      }

      await fetchServerStatus();
    } catch (error) {
      alert("삭제 중 오류가 발생했어요. 서버 연결을 확인해주세요!");
      console.error(error);
    } finally {
      setServerLoading(false);
    }
  };

  const deleteSentSignal = async (id) => {
    await deleteServerItem(
      `/api/sent-signals/${id}`,
      "이 전송된 시그널을 삭제할까요?"
    );

    if (String(selectedSignalId) === String(id)) {
      setSelectedSignalId("");
      setPositionDraft(makePositionDraft());
    }
  };

  const deleteBlockedSignal = async (id) => {
    await deleteServerItem(
      `/api/blocked-signals/${id}`,
      "이 미전송 기록을 삭제할까요?"
    );
  };

  const deleteSelectedArchive = () => {
    if (!selectedArchive) {
      alert("삭제할 주간 정리본이 없습니다.");
      return;
    }

    const range = formatShortRange(selectedArchive.startDate, selectedArchive.endDate);

    const ok = window.confirm(`${range} 주간 정리본을 삭제할까요?`);

    if (!ok) return;

    setArchives((prev) =>
      prev.filter((archive) => archive.weekKey !== selectedArchive.weekKey)
    );

    setSelectedArchiveKey("");
  };

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(archives));
  }, [archives]);

  useEffect(() => {
    if (!selectedArchiveKey && archives[0]) {
      setSelectedArchiveKey(archives[0].weekKey);
    }
  }, [archives, selectedArchiveKey]);

  useEffect(() => {
    let lastDate = getTodayText();

    const timer = setInterval(() => {
      const today = getTodayText();

      if (today !== lastDate) {
        lastDate = today;
        setTradeDate(today);
      }
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    fetchServerStatus();

    const timer = setInterval(() => {
      fetchServerStatus();
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!serverStatus) return;

    const serverSignals = serverStatus.sentSignals || [];
    const serverBlockedSignals = serverStatus.blockedSignals || [];

    setSignals((prev) => {
      const previousMap = new Map(prev.map((item) => [item.id, item]));

      return serverSignals.map((serverItem) => {
        const normalized = normalizeServerSignal(serverItem);
        const previous = previousMap.get(serverItem.id);

        return {
          ...normalized,
          positions: previous?.positions || normalized.positions,
          result: previous?.result || normalized.result,
        };
      });
    });

    setBlockedSignals(
      serverBlockedSignals.map((item) => ({
        id: item.id,
        time: item.time || "-",
        reason: item.reason || "미전송",
      }))
    );

    const selectedExists = serverSignals.some(
      (item) => String(item.id) === String(selectedSignalId)
    );

    if (!selectedSignalId && serverSignals.length > 0) {
      const latestSignal = serverSignals[serverSignals.length - 1];
      setSelectedSignalId(String(latestSignal.id));
      setPositionDraft(makeDefaultPositions());
    }

    if (selectedSignalId && !selectedExists) {
      if (serverSignals.length > 0) {
        const latestSignal = serverSignals[serverSignals.length - 1];
        setSelectedSignalId(String(latestSignal.id));
        setPositionDraft(makeDefaultPositions());
      } else {
        setSelectedSignalId("");
        setPositionDraft(makePositionDraft());
      }
    }
  }, [serverStatus, selectedSignalId]);

  const finishCurrentSignal = () => {
    if (!currentSignal) {
      setIsRunning(false);
      return;
    }

    const endTime = getTimeText();

    setSignals((prev) =>
      prev.map((item) =>
        item.id === currentSignal.id
          ? {
              ...item,
              endTime,
              status: "종료",
              result: item.result === "확인중" ? "결과 입력 필요" : item.result,
            }
          : item
      )
    );

    setIsRunning(false);
  };

  const copyText = async (text, onSuccess) => {
    try {
      await navigator.clipboard.writeText(text);
      onSuccess(true);
      setTimeout(() => onSuccess(false), 1500);
    } catch (error) {
      alert("복사에 실패했어요. 텍스트를 직접 드래그해서 복사해주세요!");
    }
  };

  const handleSelectSignal = (event) => {
    const id = event.target.value;

    if (!id) {
      setSelectedSignalId("");
      setPositionDraft(makePositionDraft());
      return;
    }

    const found = signals.find((item) => item.id === Number(id));

    setSelectedSignalId(id);
    setPositionDraft(found ? clonePositions(found.positions) : makePositionDraft());
  };

  const updateDraft = (index, key, value) => {
    setPositionDraft((prev) =>
      prev.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [key]: value } : item
      )
    );
  };

  const applyPositionRecord = () => {
    if (!selectedSignalId) {
      alert("아직 기록 적용할 시그널이 없습니다.");
      return;
    }

    setSignals((prev) =>
      prev.map((item) => {
        if (item.id !== Number(selectedSignalId)) return item;

        const moneyResults = positionDraft
          .filter((position) => position.amount.trim() !== "")
          .map((position) => formatMoney(position.amount));

        return {
          ...item,
          positions: clonePositions(positionDraft),
          result: moneyResults.length > 0 ? moneyResults.join(" / ") : "확인중",
        };
      })
    );
  };

  const savePositionRecord = () => {
    if (!positionText.trim()) {
      alert("저장할 포지션 기록이 없습니다.");
      return;
    }

    const dailyRecord = {
      date: tradeDate,
      symbol: tradeSymbol,
      text: positionText,
      updatedAt: new Date().toISOString(),
    };

    const targetWeekKey = getWeekKey(tradeDate);

    setArchives((prev) => upsertArchive(prev, dailyRecord));
    setSelectedArchiveKey(targetWeekKey);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleServerOn = async () => {
    await postServerAction("/api/manual-on");
  };

  const handleServerOff = async () => {
    await postServerAction("/api/finish-signal");
    finishCurrentSignal();
  };

  return (
    <main className="page">
      <section className="dashboard">
        <aside className="left-panel">
          <div className="card admin-card">
            <div className="card-header">
              <div>
                <p className="eyebrow">시그널 자동관리</p>
                <h1>미니 관리자</h1>
              </div>

              <span className={`status-pill ${isSignalRunning ? "running" : "waiting"}`}>
                {isSignalRunning ? "진행중" : "대기중"}
              </span>
            </div>

            <div className="current-box">
              <p className="box-title">현재 상태</p>

              {serverActiveSignal ? (
                <div>
                  <h2>
                    {serverActiveSignal.orderText ||
                      `${serverActiveSignal.order}번째 시그널`}
                  </h2>

                  <div className="info-grid">
                    <span>시작 시간</span>
                    <strong>{serverActiveSignal.startedAt || "-"}</strong>

                    <span>상태</span>
                    <strong>{serverActiveSignal.status || "진행중"}</strong>
                  </div>
                </div>
              ) : currentSignal && isRunning ? (
                <div>
                  <h2>{currentSignal.order}</h2>

                  <div className="info-grid">
                    <span>시작 시간</span>
                    <strong>{currentSignal.startTime}</strong>

                    <span>결과</span>
                    <strong>{currentSignal.result}</strong>
                  </div>
                </div>
              ) : (
                <div>
                  <h2>새 신호 대기중</h2>
                  <p className="desc">
                    종료 후 새로 들어오는 첫 신호만 다음 시그널로 반영됩니다.
                  </p>
                </div>
              )}
            </div>

            <div className="server-status-box">
              <div>
                <span>서버 연결</span>
                <strong>{serverStatus ? "연결됨" : "확인중"}</strong>
              </div>

              <div>
                <span>전달 상태</span>
                <strong>{serverStatus?.canReceiveSignal ? "전달 가능" : "잠금"}</strong>
              </div>

              <div>
                <span>운영 상태</span>
                <strong>{serverStatus?.operatingTime ? "상시 운영" : "운영 외"}</strong>
              </div>

              <div>
                <span>포지션 상태</span>
                <strong>{serverStatus?.signalRunning ? "진행중" : "대기중"}</strong>
              </div>
            </div>

            <div className="button-row">
              <button
                className={`main-button ${serverStatus?.canReceiveSignal ? "active" : ""}`}
                onClick={handleServerOn}
                disabled={serverLoading}
              >
                {serverLoading ? "처리중" : "전달 가능"}
              </button>

              <button
                className="sub-button"
                onClick={handleServerOff}
                disabled={serverLoading}
              >
                포지션 종료
              </button>
            </div>

            <div className="rule-box">
              <strong>운영 규칙</strong>
              <p>
                봇은 항상 ON 상태입니다. 포지션 진행중에는 새 이미지 신호를 보내지 않고
                기록만 남깁니다. 포지션 종료 후 새로 들어온 첫 이미지 신호가 다음 시그널입니다.
              </p>
            </div>
          </div>

          <div className="card blocked-card">
            <div className="section-title">미전송 기록</div>

            <div className="blocked-list">
              {blockedSignals.length === 0 ? (
                <div className="empty-box">아직 미전송 기록이 없습니다.</div>
              ) : (
                blockedSignals.map((item) => (
                  <div className="blocked-item" key={item.id}>
                    <div>
                      <strong>{item.id}번</strong>
                      <p>{item.reason}</p>
                    </div>

                    <div className="blocked-actions">
                      <span>{item.time}</span>
                      <button
                        className="delete-mini-button"
                        onClick={() => deleteBlockedSignal(item.id)}
                        disabled={serverLoading}
                      >
                        삭제
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>

        <section className="right-panel">
          <div className="card form-card calc-card">
            <div className="table-header">
              <div className="section-title">진입가 계산기</div>

              <button
                className="copy-button"
                onClick={() => copyText(calcText, setCalcCopied)}
              >
                {calcCopied ? "복사완료" : "계산값 복사"}
              </button>
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label>거래일</label>
                <input
                  value={tradeDate}
                  onChange={(e) => setTradeDate(e.target.value)}
                />
              </div>

              <div className="form-field">
                <label>종목</label>
                <input
                  value={tradeSymbol}
                  onChange={(e) => setTradeSymbol(e.target.value.toUpperCase())}
                />
              </div>

              <div className="form-field">
                <label>방향</label>
                <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                  <option value="LONG">롱 / LONG</option>
                  <option value="SHORT">숏 / SHORT</option>
                </select>
              </div>

              <div className="form-field">
                <label>TP 간격</label>
                <input
                  type="number"
                  value={tpGap}
                  onChange={(e) => setTpGap(e.target.value)}
                />
              </div>
            </div>

            <div className="form-grid three">
              <div className="form-field">
                <label>기준 진입가 / 2랏</label>
                <input
                  type="number"
                  value={baseEntry}
                  onChange={(e) => setBaseEntry(e.target.value)}
                />
              </div>

              <div className="form-field">
                <label>2차 진입가 / 1랏</label>
                <input
                  type="number"
                  value={entry2}
                  onChange={(e) => setEntry2(e.target.value)}
                />
              </div>

              <div className="form-field">
                <label>3차 진입가 / 1랏</label>
                <input
                  type="number"
                  value={entry3}
                  onChange={(e) => setEntry3(e.target.value)}
                />
              </div>
            </div>

            <div className="calc-result-grid two">
              <div className="calc-box">
                <p>2차 TP</p>
                <strong>{formatNumber(calc.secondTp)}</strong>
                <span>평균가 {formatNumber(calc.secondAverage)}</span>
              </div>

              <div className="calc-box">
                <p>3차 TP</p>
                <strong>{formatNumber(calc.thirdTp)}</strong>
                <span>평균가 {formatNumber(calc.thirdAverage)}</span>
              </div>
            </div>

            <p className="muted-note">
              계산식: 기준 진입가는 2랏, 2차와 3차는 1랏 기준입니다. 롱은 평균가 + TP
              간격, 숏은 평균가 - TP 간격으로 계산합니다.
            </p>
          </div>

          <div className="card form-card position-card">
            <div className="section-title">포지션 선택 패널</div>

            <p className="muted-note">
              시그널마다 1차에서 끝날 수도, 2차/3차까지 갈 수도 있어서 결과는
              여기서 직접 선택합니다.
            </p>

            <div className="form-field position-select">
              <label>기록 적용할 시그널</label>
              <select value={selectedSignalId} onChange={handleSelectSignal}>
                {signals.length === 0 ? (
                  <option value="">기록할 시그널 없음</option>
                ) : (
                  signals.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.order}
                    </option>
                  ))
                )}
              </select>
            </div>

            {positionDraft.map((position, index) => (
              <div className="position-row" key={position.round}>
                <div className="round-label">{position.round}</div>

                <div className="form-field">
                  <label>결과 선택</label>
                  <select
                    value={position.result}
                    onChange={(e) => updateDraft(index, "result", e.target.value)}
                  >
                    {resultOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>금액 직접 입력</label>
                  <input
                    value={position.amount}
                    inputMode="decimal"
                    onChange={(e) =>
                      updateDraft(index, "amount", sanitizeAmount(e.target.value))
                    }
                    placeholder="예: 2000"
                  />
                </div>
              </div>
            ))}

            <button className="apply-button" onClick={applyPositionRecord}>
              선택 결과 반영하기
            </button>

            {selectedSignal ? (
              <p className="muted-note selected-note">
                현재 선택: {selectedSignal.order}
              </p>
            ) : (
              <p className="muted-note selected-note">
                아직 기록할 시그널이 없습니다.
              </p>
            )}
          </div>

          <div className="card signal-card">
            <div className="table-header">
              <div className="section-title">전송된 시그널</div>
              <span className="count-pill">총 {signals.length}개</span>
            </div>

            <div className="table-wrap signal-table-wrap">
              <table className="signal-table">
                <thead>
                  <tr>
                    <th>순서</th>
                    <th>시작</th>
                    <th>종료</th>
                    <th>결과</th>
                    <th>상태</th>
                    <th>관리</th>
                  </tr>
                </thead>

                <tbody>
                  {signals.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="empty-table-cell">
                        아직 전송된 시그널이 없습니다.
                      </td>
                    </tr>
                  ) : (
                    signals.map((item) => (
                      <tr key={item.id}>
                        <td>{item.order}</td>
                        <td>{item.startTime}</td>
                        <td>{item.endTime}</td>
                        <td>{item.result}</td>
                        <td>
                          <span
                            className={`mini-status ${
                              item.status === "진행중" ? "running" : "done"
                            }`}
                          >
                            {item.status}
                          </span>
                        </td>
                        <td>
                          <button
                            className="delete-mini-button"
                            onClick={() => deleteSentSignal(item.id)}
                            disabled={serverLoading}
                          >
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card record-card">
            <div className="table-header">
              <div className="section-title">포지션 기록기</div>

              <div className="record-actions">
                <button className="copy-button" onClick={savePositionRecord}>
                  {saved ? "저장완료" : "저장"}
                </button>

                <button
                  className="copy-button"
                  onClick={() => copyText(positionText, setCopied)}
                >
                  {copied ? "복사완료" : "복사하기"}
                </button>
              </div>
            </div>

            <textarea
              value={positionText}
              readOnly
              placeholder="포지션 기록이 생성되면 여기에 표시됩니다."
            />
          </div>

          <div className="archive-column">
            <div className="card archive-list-card">
              <div className="table-header">
                <div className="section-title">포지션 저장함</div>
                <span className="count-pill">최근 2주</span>
              </div>

              <div className="archive-week-list">
                {archives.length === 0 ? (
                  <div className="empty-box">아직 저장된 기록이 없습니다.</div>
                ) : (
                  archives.map((archive) => (
                    <button
                      key={archive.weekKey}
                      className={`archive-week-item ${
                        selectedArchive?.weekKey === archive.weekKey ? "selected" : ""
                      }`}
                      onClick={() => setSelectedArchiveKey(archive.weekKey)}
                    >
                      <strong>{formatShortRange(archive.startDate, archive.endDate)}</strong>
                      <span>{archive.records.length}일 기록</span>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="card archive-detail-card">
              <div className="table-header">
                <div className="section-title">주간 정리본</div>

                <div className="record-actions">
                  <button
                    className="delete-mini-button"
                    onClick={deleteSelectedArchive}
                    disabled={!selectedArchive}
                  >
                    삭제
                  </button>

                  <button
                    className="copy-button"
                    onClick={() => copyText(archiveText, setArchiveCopied)}
                  >
                    {archiveCopied ? "복사완료" : "주간 복사"}
                  </button>
                </div>
              </div>

              <textarea value={archiveText} readOnly />
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
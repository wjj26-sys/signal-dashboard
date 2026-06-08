import React, { useEffect, useMemo, useRef } from "react";
import { createChart, CandlestickSeries, LineStyle } from "lightweight-charts";

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function makeFiveMinuteCandles(priceHistory) {
  const bucketMs = 5 * 60 * 1000;
  const candleMap = new Map();

  const sortedTicks = [...(priceHistory || [])]
    .map((item) => {
      const price = toNumber(item.price);
      const dateText = item.checkedAt || item.createdAt;

      if (price === null || !dateText) return null;

      const timestamp = new Date(dateText).getTime();

      if (!Number.isFinite(timestamp)) return null;

      return {
        price,
        timestamp,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);

  sortedTicks.forEach((tick) => {
    const bucketStartMs = Math.floor(tick.timestamp / bucketMs) * bucketMs;
    const time = Math.floor(bucketStartMs / 1000);
    const price = Number(tick.price.toFixed(2));

    const existing = candleMap.get(time);

    if (!existing) {
      candleMap.set(time, {
        time,
        open: price,
        high: price,
        low: price,
        close: price,
      });

      return;
    }

    existing.high = Number(Math.max(existing.high, price).toFixed(2));
    existing.low = Number(Math.min(existing.low, price).toFixed(2));
    existing.close = price;
  });

  return Array.from(candleMap.values()).sort((a, b) => a.time - b.time);
}

function makeFallbackCandles(setup) {
  const values = [
    setup.baseEntry,
    setup.entry2,
    setup.entry3,
    setup.firstTp,
    setup.secondTp,
    setup.thirdTp,
    setup.slPrice,
  ]
    .map(toNumber)
    .filter((value) => value !== null);

  const center =
    values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 4500;

  const now = Math.floor(Date.now() / 1000);
  const candles = [];

  for (let index = 24; index >= 1; index -= 1) {
    const time = now - index * 300;
    const wave = Math.sin(index / 2.5) * 6;
    const open = center + wave;
    const close = open + Math.cos(index / 1.7) * 3;
    const high = Math.max(open, close) + 2;
    const low = Math.min(open, close) - 2;

    candles.push({
      time,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
    });
  }

  return candles;
}

export default function SetupChart({ setup, priceHistory }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const priceLineRefs = useRef([]);

  const hasInitialDataRef = useRef(false);
  const hasFitContentRef = useRef(false);
  const previousCandleCountRef = useRef(0);
  const previousLastTimeRef = useRef(null);
  const previousModeRef = useRef("fallback");

  const chartData = useMemo(() => {
    const realCandles = makeFiveMinuteCandles(priceHistory);

    if (realCandles.length >= 1) {
      return {
        mode: "real",
        candles: realCandles,
      };
    }

    return {
      mode: "fallback",
      candles: makeFallbackCandles(setup || {}),
    };
  }, [priceHistory, setup]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 520,
      layout: {
        background: { color: "#ffffff" },
        textColor: "#172033",
      },
      grid: {
        vertLines: { color: "#edf2f7" },
        horzLines: { color: "#edf2f7" },
      },
      rightPriceScale: {
        borderColor: "#e2e8f0",
      },
      timeScale: {
        borderColor: "#e2e8f0",
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#16a34a",
      downColor: "#ef4444",
      borderUpColor: "#16a34a",
      borderDownColor: "#ef4444",
      wickUpColor: "#16a34a",
      wickDownColor: "#ef4444",
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const handleResize = () => {
      if (!containerRef.current || !chartRef.current) return;

      chartRef.current.applyOptions({
        width: containerRef.current.clientWidth,
      });
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);

      if (chartRef.current) {
        chartRef.current.remove();
      }

      chartRef.current = null;
      candleSeriesRef.current = null;
      priceLineRefs.current = [];

      hasInitialDataRef.current = false;
      hasFitContentRef.current = false;
      previousCandleCountRef.current = 0;
      previousLastTimeRef.current = null;
      previousModeRef.current = "fallback";
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current) return;

    const candles = chartData.candles || [];
    const mode = chartData.mode;

    if (candles.length === 0) return;

    const lastCandle = candles[candles.length - 1];
    const modeChanged = previousModeRef.current !== mode;
    const candleCountChanged =
      previousCandleCountRef.current !== candles.length;
    const lastTimeChanged = previousLastTimeRef.current !== lastCandle.time;

    // 처음 열었을 때 / 가짜 데이터에서 실제 데이터로 전환될 때 / 과거 데이터가 늘어났을 때만 전체 세팅
    if (
      !hasInitialDataRef.current ||
      modeChanged ||
      candleCountChanged ||
      lastTimeChanged
    ) {
      candleSeriesRef.current.setData(candles);

      hasInitialDataRef.current = true;
      previousCandleCountRef.current = candles.length;
      previousLastTimeRef.current = lastCandle.time;
      previousModeRef.current = mode;

      // 차트 열릴 때 한 번만 자동 맞춤. 이후 사용자가 축소한 상태 유지
      if (!hasFitContentRef.current) {
        const visibleCount = 36;
        const totalCount = candles.length;

        if (totalCount > visibleCount) {
          chartRef.current.timeScale().setVisibleLogicalRange({
            from: totalCount - visibleCount,
            to: totalCount + 5,
          });
        } else {
          chartRef.current.timeScale().fitContent();
        }

        hasFitContentRef.current = true;
      }

      return;
    }

    // 같은 5분봉 안에서는 현재 봉만 갱신
    candleSeriesRef.current.update(lastCandle);

    previousCandleCountRef.current = candles.length;
    previousLastTimeRef.current = lastCandle.time;
    previousModeRef.current = mode;
  }, [chartData]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;

    priceLineRefs.current.forEach((line) => {
      candleSeriesRef.current.removePriceLine(line);
    });

    priceLineRefs.current = [];

    const priceLines = [
      {
        value: setup?.slPrice,
        title: "SL 손절",
        color: "#2563eb",
      },
      {
        value: setup?.firstTp,
        title: "1차 TP",
        color: "#16a34a",
      },
      {
        value: setup?.secondTp,
        title: "2차 TP",
        color: "#16a34a",
      },
      {
        value: setup?.thirdTp,
        title: "3차 TP",
        color: "#16a34a",
      },
      {
        value: setup?.entry2,
        title: "2차 진입",
        color: "#facc15",
      },
      {
        value: setup?.entry3,
        title: "3차 진입",
        color: "#ef4444",
      },
    ];

    priceLines.forEach((line) => {
      const price = toNumber(line.value);

      if (price === null) return;

      const roundedPrice = Math.round(price);

      const createdLine = candleSeriesRef.current.createPriceLine({
        price: roundedPrice,
        color: line.color,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: line.title,
      });

      priceLineRefs.current.push(createdLine);
    });
  }, [setup]);

  return <div className="setup-chart-box" ref={containerRef} />;
}
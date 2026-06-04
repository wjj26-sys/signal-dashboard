import React, { useEffect, useMemo, useRef } from "react";
import { createChart, CandlestickSeries, LineStyle } from "lightweight-charts";

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function makeDemoCandles(setup) {
  const values = [
    setup.baseEntry,
    setup.entry2,
    setup.entry3,
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

  for (let index = 20; index >= 1; index -= 1) {
    const time = now - index * 300;
    const wave = Math.sin(index / 2.5) * 8;
    const open = center + wave;
    const close = open + Math.cos(index / 1.7) * 4;
    const high = Math.max(open, close) + 5;
    const low = Math.min(open, close) - 5;

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

export default function SetupChart({ setup }) {
  const containerRef = useRef(null);

  const candles = useMemo(() => makeDemoCandles(setup || {}), [setup]);

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
    });

    candleSeries.setData(candles);

    const priceLines = [
      {
        value: setup?.slPrice,
        title: "SL 손절",
        color: "#2563eb",
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

      candleSeries.createPriceLine({
        price: roundedPrice,
        color: line.color,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: line.title,
      });
    });

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (!containerRef.current) return;

      chart.applyOptions({
        width: containerRef.current.clientWidth,
      });
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, [candles, setup]);

  return <div className="setup-chart-box" ref={containerRef} />;
}
import React, { useEffect, useMemo, useRef } from "react";
import { createChart, LineSeries, LineStyle } from "lightweight-charts";

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeHistory(priceHistory) {
  const points = new Map();

  (priceHistory || []).forEach((item) => {
    const price = toNumber(item.price);
    const dateText = item.checkedAt || item.createdAt;

    if (price === null || !dateText) return;

    const time = Math.floor(new Date(dateText).getTime() / 1000);

    if (!Number.isFinite(time)) return;

    points.set(time, {
      time,
      value: Number(price.toFixed(2)),
    });
  });

  return Array.from(points.values()).sort((a, b) => a.time - b.time);
}

function makeFallbackLine(setup) {
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
  const points = [];

  for (let index = 30; index >= 1; index -= 1) {
    const time = now - index * 60;
    const wave = Math.sin(index / 3) * 5;
    const value = center + wave;

    points.push({
      time,
      value: Number(value.toFixed(2)),
    });
  }

  return points;
}

export default function SetupChart({ setup, priceHistory }) {
  const containerRef = useRef(null);

  const lineData = useMemo(() => {
    const realData = normalizeHistory(priceHistory);

    if (realData.length >= 2) {
      return realData;
    }

    return makeFallbackLine(setup || {});
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

    const priceSeries = chart.addSeries(LineSeries, {
      lineWidth: 2,
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    priceSeries.setData(lineData);

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

      priceSeries.createPriceLine({
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
  }, [lineData, setup]);

  return <div className="setup-chart-box" ref={containerRef} />;
}
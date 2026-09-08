"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

// Фоновые фотографии формата webp из public/backgrounds.
const BACKGROUNDS = [
  "bg_1.webp",
  "bg_2.webp",
  "bg_3.webp",
  "bg_4.webp",
  "bg_5.webp",
  "bg_6.webp",
  "bg_7.webp",
  "bg_8.webp",
  "bg_9.webp",
];

const SLIDE_INTERVAL_MS = 10_000; // смена каждые 10 секунд
const FADE_MS = 1500; // длительность плавного кроссфейда

// Перемешанный список индексов (каждый по одному разу) — алгоритм Фишера—Йетса.
function makeShuffledSequence(len: number): number[] {
  const arr = Array.from({ length: len }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

type SlideshowState = { current: number; queue: number[] };

export default function BackgroundSlideshow() {
  // Очередь оставшихся индексов: берём по одному, не повторяясь, пока не
  // исчерпаем весь список, затем начинаем новый перемешанный цикл.
  // Стартовая фотография — случайная, сразу убираем её из очереди.
  const [state, setState] = useState<SlideshowState>(() => {
    const seq = makeShuffledSequence(BACKGROUNDS.length);
    return { current: seq.shift()!, queue: seq };
  });

  useEffect(() => {
    const t = setInterval(() => {
      setState((prev) => {
        const queue = prev.queue.length === 0 ? makeShuffledSequence(BACKGROUNDS.length) : prev.queue;
        const [next, ...rest] = queue;
        return { current: next, queue: rest };
      });
    }, SLIDE_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  // Предзагрузка следующей фотографии, чтобы смена шла без «миганий».
  useEffect(() => {
    const next = state.queue[0];
    if (next === undefined) return;
    const img = new Image();
    img.src = `/backgrounds/${BACKGROUNDS[next]}`;
  }, [state]);

  return (
    <div aria-hidden className="fx-bg">
      <AnimatePresence>
        <motion.img
          key={state.current}
          src={`/backgrounds/${BACKGROUNDS[state.current]}`}
          alt=""
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: FADE_MS / 1000, ease: "easeInOut" }}
          className="fx-slide-img"
        />
      </AnimatePresence>
      {/* Затемнение поверх фото, чтобы текст и карточки оставались читаемыми */}
      <div className="fx-slide-overlay" />
    </div>
  );
}


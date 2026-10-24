'use client';

import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { subscribe } from '../lib/stream';

// Categorical palette (dark steps), assigned in the order sessions first appear and never reused.
// Validated with the dataviz skill's validate_palette.js against the dark page surface.
const SERIES_COLORS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
];
const MAX_POINTS = 500;
const INK = '#9ca3af'; // gray-400, for axes and labels
const GRID = '#374151'; // gray-700

type Point = { at: number; trust: number };
type Series = { sessionId: string; color: string; points: Point[] };

export default function TrustGraph() {
  const [series, setSeries] = useState<Series[]>([]);

  useEffect(
    () =>
      subscribe((events) => {
        const trust = events.filter((e) => e.type === 'trust');
        if (trust.length === 0) return;
        setSeries((prev) => {
          const next = prev.map((s) => ({ ...s }));
          for (const e of trust) {
            let s = next.find((x) => x.sessionId === e.session_id);
            if (!s) {
              if (next.length >= SERIES_COLORS.length) continue; // more than 8 sessions: only the first 8 are drawn
              s = { sessionId: e.session_id, color: SERIES_COLORS[next.length], points: [] };
              next.push(s);
            }
            s.points = [...s.points, { at: e.at, trust: e.session_trust }].slice(-MAX_POINTS);
          }
          return next;
        });
      }),
    [],
  );

  return (
    <section className="mb-8 max-w-3xl">
      <h2 className="mb-2 text-lg font-semibold">Session trust</h2>
      {series.length === 0 ? (
        <p className="text-sm text-gray-400">No trust events yet.</p>
      ) : (
        <div className="h-72 rounded border border-gray-700 p-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart margin={{ top: 8, right: 72, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="at"
                type="number"
                domain={['dataMin', 'dataMax']}
                scale="time"
                tickFormatter={(t: number) => new Date(t).toLocaleTimeString()}
                stroke={INK}
                tick={{ fill: INK, fontSize: 11 }}
              />
              <YAxis
                domain={[0, 100]}
                ticks={[0, 20, 40, 60, 80, 100]}
                width={32}
                stroke={INK}
                tick={{ fill: INK, fontSize: 11 }}
              />

              {/* Routing thresholds (final_contracts.md pipeline step 7); each label names the band above its line */}
              <ReferenceLine
                y={60}
                stroke={INK}
                strokeDasharray="4 4"
                label={{ value: 'grants', position: 'insideBottomLeft', fill: INK, fontSize: 11 }}
              />
              <ReferenceLine
                y={40}
                stroke={INK}
                strokeDasharray="4 4"
                label={{
                  value: 'judge only',
                  position: 'insideBottomLeft',
                  fill: INK,
                  fontSize: 11,
                }}
              />
              <ReferenceLine
                y={20}
                stroke={INK}
                strokeDasharray="4 4"
                label={{
                  value: 'human only',
                  position: 'insideBottomLeft',
                  fill: INK,
                  fontSize: 11,
                }}
              />
              <ReferenceArea
                y1={0}
                y2={20}
                fillOpacity={0}
                label={{
                  value: 'quarantine',
                  position: 'insideBottomLeft',
                  fill: INK,
                  fontSize: 11,
                }}
              />

              <Tooltip
                contentStyle={{ background: '#111827', border: `1px solid ${GRID}`, fontSize: 12 }}
                labelStyle={{ color: INK }}
                labelFormatter={(t) => new Date(Number(t)).toLocaleTimeString()}
                formatter={(value, name) => [value, name]}
              />
              {series.length >= 2 && <Legend wrapperStyle={{ fontSize: 12, color: INK }} />}

              {series.map((s) => (
                <Line
                  key={s.sessionId}
                  data={s.points}
                  dataKey="trust"
                  name={s.sessionId}
                  type="stepAfter"
                  stroke={s.color}
                  strokeWidth={2}
                  isAnimationActive={false}
                  dot={{ r: 4, fill: s.color, stroke: '#0a0a0a', strokeWidth: 2 }}
                  label={
                    series.length <= 4 ? (
                      <EndLabel count={s.points.length} name={s.sessionId} />
                    ) : (
                      false
                    )
                  }
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

// Direct label at the last point of a line: the session id and its current trust.
function EndLabel(props: {
  x?: number | string;
  y?: number | string;
  index?: number;
  value?: unknown;
  count: number;
  name: string;
}) {
  if (props.index !== props.count - 1) return null;
  return (
    <text x={Number(props.x) + 8} y={Number(props.y)} dy={4} fill={INK} fontSize={11}>
      {props.name} · {String(props.value)}
    </text>
  );
}

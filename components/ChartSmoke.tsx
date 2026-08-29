"use client";

import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Hard-coded data — this is only a SSR + hydration smoke test (docs/PLAN.md §7).
const data = [
  { day: "T-4", value: 42 },
  { day: "T-3", value: 55 },
  { day: "T-2", value: 48 },
  { day: "T-1", value: 61 },
  { day: "T", value: 73 },
];

export function ChartSmoke() {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis dataKey="day" fontSize={12} />
          <YAxis fontSize={12} width={32} />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#2563eb"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Charts, drawn as inline SVG.
 *
 * Two chart shapes are all the dashboard needs, and hand-drawing them keeps the
 * palette identical to the rest of the interface and removes a dependency we
 * would otherwise have to justify. Both take live data and render nothing when
 * there is none, rather than showing an empty frame.
 */
import { formatMoneyShort } from '../lib/format.ts';

type BarDatum = { label: string; value: number };

export function BarChart({ data, height = 200 }: { data: BarDatum[]; height?: number }) {
  if (data.length === 0) {
    return <p className="muted">No payroll in this period yet.</p>;
  }

  const maximum = Math.max(...data.map((item) => item.value), 1);
  const barHeight = 22;
  const gap = 10;
  const labelWidth = 132;
  const chartHeight = Math.max(data.length * (barHeight + gap), height);

  return (
    <svg
      width="100%"
      height={chartHeight}
      viewBox={`0 0 520 ${chartHeight}`}
      preserveAspectRatio="xMinYMin meet"
      role="img"
      aria-label="Salary cost by department"
    >
      {data.map((item, index) => {
        const y = index * (barHeight + gap);
        const width = Math.max((item.value / maximum) * (520 - labelWidth - 74), 2);
        return (
          <g key={item.label}>
            <text x="0" y={y + 15} fontSize="12" fill="var(--gray-700)">
              {item.label.length > 18 ? `${item.label.slice(0, 17)}…` : item.label}
            </text>
            <rect
              x={labelWidth} y={y} width={width} height={barHeight}
              fill="var(--plum)" rx="2"
            />
            <text
              x={labelWidth + width + 6} y={y + 15}
              fontSize="11" fill="var(--gray-600)" fontWeight="600"
            >
              {formatMoneyShort(item.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

type LineDatum = { label: string; value: number };

export function LineChart({ data }: { data: LineDatum[] }) {
  if (data.length === 0) {
    return <p className="muted">No payroll history in this period yet.</p>;
  }

  if (data.length === 1) {
    const only = data[0] as LineDatum;
    return (
      <p className="muted">
        Only one month of payroll history so far ({only.label}: {formatMoneyShort(only.value)}).
        A trend needs at least two.
      </p>
    );
  }

  const width = 520;
  const height = 200;
  const padding = { top: 16, right: 16, bottom: 28, left: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const maximum = Math.max(...data.map((item) => item.value));
  const minimum = Math.min(...data.map((item) => item.value), 0);
  const span = maximum - minimum || 1;

  const pointAt = (index: number, value: number): [number, number] => [
    padding.left + (index / (data.length - 1)) * plotWidth,
    padding.top + plotHeight - ((value - minimum) / span) * plotHeight,
  ];

  const points = data.map((item, index) => pointAt(index, item.value));
  const path = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const area = `${path} L${points[points.length - 1]?.[0]},${padding.top + plotHeight} L${points[0]?.[0]},${padding.top + plotHeight} Z`;

  return (
    <svg
      width="100%" height={height} viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMinYMin meet" role="img" aria-label="Monthly net salary trend"
    >
      {[0, 0.5, 1].map((fraction) => {
        const y = padding.top + plotHeight * (1 - fraction);
        return (
          <g key={fraction}>
            <line
              x1={padding.left} y1={y} x2={width - padding.right} y2={y}
              stroke="var(--gray-200)" strokeWidth="1"
            />
            <text x="0" y={y + 4} fontSize="10" fill="var(--gray-500)">
              {formatMoneyShort(minimum + span * fraction)}
            </text>
          </g>
        );
      })}

      <path d={area} fill="var(--teal)" opacity="0.1" />
      <path d={path} fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinejoin="round" />

      {points.map(([x, y], index) => (
        <g key={data[index]?.label}>
          <circle cx={x} cy={y} r="3.5" fill="var(--surface)" stroke="var(--teal)" strokeWidth="2" />
          <title>{`${data[index]?.label}: ${formatMoneyShort(data[index]?.value ?? 0)}`}</title>
        </g>
      ))}

      {data.map((item, index) => (
        <text
          key={item.label}
          x={points[index]?.[0]} y={height - 8}
          fontSize="10" fill="var(--gray-600)" textAnchor="middle"
        >
          {item.label.slice(2)}
        </text>
      ))}
    </svg>
  );
}

/**
 * How an employee's scheduled days were spent, as one composition bar.
 *
 * Deliberately not a donut. This is part-to-whole, which a stacked bar reads
 * better than a ring for two reasons that both apply here: the category names
 * are long ("Unexplained absence"), and the interesting segments are the small
 * ones -- one absence in sixty-five days is a 1.5% slice, and arcs are exactly
 * where small and close values become impossible to compare. A ring would also
 * have pushed the counts into a legend; on a bar they sit on the same line as
 * the thing they describe.
 *
 * The figures are the primary read and the bar is the summary, not the other way
 * round: for a typical employee three of the four numbers are 0 or 1, and what
 * the reader wants from the panel is "is there anything wrong here", which is a
 * number, not a shape.
 *
 * Colour is never the only carrier -- every segment is named and counted in the
 * list beneath -- but the four hues were still validated as an adjacent set for
 * lightness, chroma, contrast, and separation under protanopia, deuteranopia and
 * tritanopia, because "there's a label too" is not a reason to ship a palette
 * two of whose segments look identical.
 */
export type AttendanceSummary = {
  scheduled_days: number;
  present_days: number;
  paid_leave_days: number;
  unpaid_leave_days: number;
  absent_days: number;
  from_date: string;
  to_date: string;
  window_days: number;
};

type Segment = {
  key: keyof Pick<
    AttendanceSummary,
    'present_days' | 'paid_leave_days' | 'unpaid_leave_days' | 'absent_days'
  >;
  label: string;
  colour: string;
  /** What this segment means, for the reader who has not built the system. */
  note: string;
};

const SEGMENTS: Segment[] = [
  { key: 'present_days', label: 'Attended', colour: 'var(--attend-present)',
    note: 'a scheduled day with an attendance record' },
  { key: 'paid_leave_days', label: 'Paid leave', colour: 'var(--attend-paid)',
    note: 'approved leave that is paid' },
  { key: 'unpaid_leave_days', label: 'Unpaid leave', colour: 'var(--attend-unpaid)',
    note: 'approved leave that reduces pay' },
  { key: 'absent_days', label: 'Unexplained', colour: 'var(--attend-absent)',
    note: 'scheduled, but no attendance and no approved leave' },
];

export function AttendanceComposition({ data }: { data: AttendanceSummary }) {
  const total = data.scheduled_days;

  if (total === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        No scheduled working days in the last {data.window_days} days — this employee has no
        working schedule assigned, so there is nothing to measure attendance against.
      </p>
    );
  }

  const rows = SEGMENTS.map((segment) => ({
    ...segment,
    days: data[segment.key],
    share: (data[segment.key] / total) * 100,
  }));

  return (
    <div className="composition">
      <div
        className="composition__bar"
        role="img"
        aria-label={
          `Of ${total} scheduled days: ` +
          rows.filter((r) => r.days > 0).map((r) => `${r.days} ${r.label.toLowerCase()}`).join(', ')
        }
      >
        {rows
          .filter((row) => row.days > 0)
          .map((row) => (
            <span
              key={row.key}
              className="composition__segment"
              style={{ flexGrow: row.days, background: row.colour }}
            >
              <title>{`${row.label}: ${row.days} of ${total} days`}</title>
            </span>
          ))}
      </div>

      {/* Legend and direct labels in one: the swatch names the segment, the
          figure is the value, and nothing depends on matching a colour by eye. */}
      <dl className="composition__key">
        {rows.map((row) => (
          <div
            key={row.key}
            className={`composition__item${row.days === 0 ? ' composition__item--empty' : ''}`}
            title={row.note}
          >
            <dt>
              <span className="composition__swatch" style={{ background: row.colour }} aria-hidden="true" />
              {row.label}
            </dt>
            <dd>
              <strong>{row.days}</strong>
              <span className="composition__share">{row.share.toFixed(0)}%</span>
            </dd>
          </div>
        ))}
      </dl>

      <p className="composition__footnote">
        {total} scheduled working days, {data.from_date} to {data.to_date}. Rest days are not
        counted. A day covered by approved leave counts as leave even if a punch also exists for
        it, which is the same rule payroll applies.
      </p>
    </div>
  );
}

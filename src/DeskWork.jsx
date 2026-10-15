const POSITIONS = {
  reception: [18.8, 29.3], evidence: [35.7, 30.8], policy: [58.1, 31.3],
  payments: [74.7, 31.6], archive: [91.4, 35], review: [60.8, 69],
};

// Desk props illustrate the current stage. They never decide or record an outcome.
export function DeskWork({ frame, phase, entering }) {
  if (phase === 'ready' || phase === 'preview') return null;
  const [x, y] = POSITIONS[frame.station];
  return <div className={`desk-work work-${frame.station} ${entering ? 'work-entering' : 'work-restored'} ${frame.terminal ? 'work-finished' : ''}`}
    style={{ left: `${x}%`, top: `${y}%` }} aria-hidden="true">
    {frame.station === 'archive'
      ? <><span className="archive-slot" /><img className="archive-file" src="/assets/case-folder.png" alt="" draggable="false" /></>
      : <>
        <span className="work-paper"><i /><i /><i /><span className="paper-scan" /></span>
        {frame.station === 'policy' && <span className="rule-markers"><i /><i /><i /></span>}
        {frame.station === 'payments' && <span className="receipt-slot" />}
        {frame.station === 'review' && <span className="review-clip" />}
        {frame.station === 'reception' && <span className="intake-stamp" />}
      </>}
  </div>;
}

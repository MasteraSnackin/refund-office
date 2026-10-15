import { useLayoutEffect, useRef, useState } from 'react';
import { Check, FileSearch, FolderCheck, Inbox, Pause, ReceiptText, ShieldCheck } from 'lucide-react';
import { DeskWork } from './DeskWork.jsx';

const MONITORS = [
  { station: 'reception', x: 14.1, y: 31.8 },
  { station: 'evidence', x: 32.4, y: 24.6 },
  { station: 'policy', x: 54.7, y: 25.2 },
  { station: 'payments', x: 71.4, y: 26.2 },
  { station: 'archive', x: 88.3, y: 26.1 },
  { station: 'evidence', x: 32.3, y: 51.4 },
];
const CLERKS = [
  { station: 'evidence', x: 32.6, y: 42 },
  { station: 'policy', x: 54.7, y: 43 },
  { station: 'payments', x: 71.7, y: 43 },
  { station: 'archive', x: 88.2, y: 43 },
];
const ACTIVITIES = {
  reception: ['Opening the case', Inbox],
  evidence: ['Reading the records', FileSearch],
  policy: ['Checking the rules', ShieldCheck],
  payments: ['Preparing the refund', ReceiptText],
  archive: ['Filing the case', FolderCheck],
  review: ['Waiting for review', Pause],
};

export function OfficeLife({ activeStation, frame, phase, frameKey, motionEnabled, stageEntranceKey }) {
  const entering = motionEnabled && stageEntranceKey === frameKey;
  const running = phase === 'running';
  const terminal = phase === 'complete';
  const [activity, WorkIcon] = ACTIVITIES[frame.station];
  const Icon = terminal ? ['held', 'awaiting-approval', 'pending', 'failed'].includes(frame.outcome) ? Pause : Check : WorkIcon;
  const activityTop = frame.station === 'review' ? 83 : frame.station === 'evidence' ? 45 : 48;
  const label = frame.activityLabel || (phase === 'paused' ? 'Paused' : terminal
    ? frame.outcome === 'refunded' ? 'Receipt filed' : frame.outcome === 'held' ? 'Waiting for review' : 'Previous remedy found'
    : activity);

  return <>
    <div className="office-life" aria-hidden="true">
      {MONITORS.map((monitor, i) => <span key={i}
        className={`screen-glow ${running && monitor.station === frame.station ? 'is-working' : ''}`}
        style={{ left: `${monitor.x}%`, top: `${monitor.y}%`, animationDelay: `${i * -1.7}s` }} />)}
      {CLERKS.map((clerk, i) => <div key={clerk.station}
        className={`desk-clerk ${clerk.station === frame.station && running ? 'clerk-typing' : 'clerk-idle'}`}
        style={{ left: `${clerk.x}%`, top: `${clerk.y}%`, '--clerk-delay': `${i * -2.9}s` }}>
        <img src="/assets/desk-clerk.png" alt="" draggable="false" />
      </div>)}
      <div className="office-courier"><span className="courier-facing"><img src="/assets/investigator.png" alt="" draggable="false" /></span></div>
    </div>
    <Investigator station={activeStation} frameKey={frameKey} phase={phase} motionEnabled={motionEnabled} />
    <DeskWork key={`work-${frameKey}`} frame={frame} phase={phase} entering={entering} />
    {(running || terminal || phase === 'paused') && <>
      {entering && <div key={`file-${frameKey}`} className="case-handoff" aria-hidden="true" style={{
        '--from-x': `${activeStation.walk[0]}%`, '--from-y': `${activeStation.walk[1] - 4}%`,
        '--to-x': `${activeStation.x}%`, '--to-y': `${activeStation.y}%`,
      }}><img src="/assets/case-folder.png" alt="" draggable="false" /></div>}
      <div key={`activity-${frameKey}`} className={`station-activity ${terminal ? 'activity-terminal' : 'activity-working'} ${entering ? 'activity-entering' : ''} ${['held', 'awaiting-approval', 'pending', 'failed'].includes(frame.outcome) ? 'activity-hold' : ''}`}
        style={{ left: `${activeStation.x}%`, top: `${activityTop}%` }} aria-hidden="true">
        <Icon size={15} /><span>{label}</span>{running && <span className="activity-dots"><span /><span /><span /></span>}
      </div>
    </>}
  </>;
}

function Investigator({ station, frameKey, phase, motionEnabled }) {
  const actorRef = useRef(null);
  const animationRef = useRef(null);
  const positionRef = useRef(station.walk);
  const [travelling, setTravelling] = useState(false);
  const [facing, setFacing] = useState(1);

  useLayoutEffect(() => {
    const previous = positionRef.current;
    const destination = station.walk;
    positionRef.current = destination;
    animationRef.current?.cancel();
    setFacing(destination[0] < previous[0] ? -1 : 1);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!motionEnabled || reduced || phase === 'preview' || phase === 'ready' || previous === destination) {
      setTravelling(false);
      return;
    }
    setTravelling(true);
    const animation = actorRef.current.animate([
      { left: `${previous[0]}%`, top: `${previous[1]}%` },
      { left: `${destination[0]}%`, top: `${destination[1]}%` },
    ], { duration: 1150, easing: 'ease-in-out' });
    animationRef.current = animation;
    // Arrival changes only the illustration. The local service owns decisions.
    animation.onfinish = () => setTravelling(false);
    if (phase === 'paused') animation.pause();
    return () => { animation.onfinish = null; animation.cancel(); };
  }, [frameKey, motionEnabled]);

  useLayoutEffect(() => {
    const animation = animationRef.current;
    if (!animation || animation.playState === 'finished' || animation.playState === 'idle') return;
    if (phase === 'paused') animation.pause();
    else animation.play();
  }, [phase]);

  return <div ref={actorRef} className={`investigator motion-investigator ${travelling ? 'walking' : phase === 'running' ? 'investigator-working' : ''}`}
    style={{ left: `${station.walk[0]}%`, top: `${station.walk[1]}%` }} aria-hidden="true">
    <span className="investigator-facing" style={{ transform: `scaleX(${facing})` }}><img src="/assets/investigator.png" alt="" draggable="false" /></span>
  </div>;
}

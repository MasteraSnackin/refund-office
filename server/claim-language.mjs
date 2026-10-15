// Conservative, deterministic interpretation for the disconnected rehearsal.
// It recognises bounded missing-item wording; it is not general language AI.
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalise = value => String(value || '').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
const missing = "(?:missing|omitted|absent|left out|not sent|not packed|not included|not supplied|not received|never arrived|never turned up|did not arrive|didn't arrive|has not arrived|hasn't arrived)";
const lead = "(?:missing|omitted|did not receive|didn't receive|have not received|haven't received|did not get|didn't get|have not got|haven't got|without)";
export function inspectClaimLanguage({ complaint, order, evidence = [] } = {}) {
  const statements = [complaint, ...evidence.filter(e => e?.kind === 'customer-clarification' && e.source === 'Customer clarification recorded by reviewer').map(e => e.body)];
  const text = statements.map(normalise).join(' . ');
  const deliveryDispute = /\b(parcel|package|delivery) (is |was |has |has been )?(not received|never arrived|not arrived|didn't arrive|hasn't arrived)\b|\b(parcel|package|delivery) (is |was )?(missing|lost)([.!?,]|$)|\b(have not|haven't|did not|didn't) received (the |my )?(parcel|package)|\bno (parcel|package) arrived\b|\btracking\b.{0,50}\bdelivered\b/.test(text);
  // Retain contradictions, negation and uncertainty from every statement. A
  // selected item and an instruction to pay cannot overrule the evidence.
  const blocked = /\b(not missing|isn't missing|wasn't missing|not actually missing|no longer missing|nothing (is |was )?missing|no (items? |products? )?(is |are |was |were )?missing|all (the )?items? (arrived|received|were received)|everything (arrived|was received))\b/.test(text)
    || /\b(?:don't|do not|didn't|did not) (?:think|believe|say|mean|claim)\b.{0,100}\b(?:missing|omitted|absent)\b/.test(text)
    || /\b(?:not (?:saying|claiming)|if|maybe|perhaps|might|may|possibly|possibly missing|unsure|not sure|cannot tell|can't tell|either)\b.{0,100}\b(?:missing|omitted|absent|received)\b/.test(text)
    || /\b(?:ignore|override|bypass)\b.{0,60}\b(?:policy|rules|instructions|checks|approval)\b/.test(text);
  const lines = order?.lines || [];
  const names = lines.map(line => normalise(line.name));
  // This narrower catalogue-reference check does not decide what was claimed.
  // It only prevents a model from choosing between several omissions when the
  // saved statements name no item (or name several).
  const words = value => normalise(value).replace(/[^a-z0-9]+/g, ' ').trim();
  const padded = ' ' + words(text) + ' ';
  const referencedLineIds = lines.filter(line => [line.name, line.id].some(name => words(name) && padded.includes(' ' + words(name) + ' '))).map(line => line.id);
  const reportsMissing = noun => new RegExp(`\\b(?:${noun})(?: from (?:this|the|my) (?:order|parcel|package))? (?:(?:is|are|was|were|has been|have been|that was|that were) )?${missing}\\b`).test(text)
    || new RegExp(`\\b${lead} (?:(?:the|my|a|an|one|two|three) )?(?:${noun})\\b`).test(text)
    || new RegExp(`\\b(?:${noun}) (?:is|was) the (?:missing|omitted) (?:item|product)(?:\\b)`).test(text)
    || new RegExp(`\\bthe (?:missing|omitted) (?:item|product) (?:is|was) (?:the |my )?(?:${noun})\\b`).test(text);
  const mentionedLineIds = lines.filter(line => {
    const name = normalise(line.name), noun = name.split(' ').at(-1);
    const aliases = [name, normalise(line.id)];
    if (noun.length >= 3 && names.filter(value => value.split(' ').at(-1) === noun).length === 1) aliases.push(noun);
    return aliases.filter(Boolean).some(alias => reportsMissing(escape(alias)));
  }).map(line => line.id);
  // Alternatives are uncertain even if only one branch contains a predicate.
  const ambiguous = /\bor\b/.test(text) && lines.filter(line => new RegExp(`\\b${escape(normalise(line.name))}\\b`).test(text)).length > 1;
  return { deliveryDispute, blocked: blocked || ambiguous, mentionedLineIds, referencedLineIds, genericMissing: reportsMissing('items?|products?') };
}

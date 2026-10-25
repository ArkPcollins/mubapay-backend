'use strict';
const { E } = require('./errors');

/**
 * Minimal state machine helper. `transitions` maps state -> allowed next states.
 * `transition()` performs an atomic conditional update so concurrent actors
 * cannot both move the same document out of the same state.
 */
function defineMachine(name, transitions) {
  const canTransition = (from, to) => (transitions[from] || []).includes(to);
  const assert = (from, to) => {
    if (!canTransition(from, to)) throw E.invalidState(`${name} cannot move from "${from}" to "${to}"`, { from, to });
  };
  async function transition(Model, id, from, to, extraSet = {}, { session, push } = {}) {
    const fromList = Array.isArray(from) ? from : [from];
    fromList.forEach((f) => assert(f, to));
    const update = { $set: { status: to, ...extraSet } };
    if (push) update.$push = push;
    const doc = await Model.findOneAndUpdate({ _id: id, status: { $in: fromList } }, update, { new: true, session });
    if (!doc) {
      const current = await Model.findById(id, { status: 1 }).session(session || null).lean();
      if (!current) throw E.notFound(name);
      throw E.invalidState(`${name} is "${current.status}" and cannot move to "${to}"`, { current: current.status, to });
    }
    return doc;
  }
  return { name, transitions, canTransition, assert, transition, states: Object.keys(transitions) };
}

module.exports = { defineMachine };

import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_REVIEW_ROUNDS, completedRounds, eligiblePullRequest, hasCompleteReceipt, isReviewCommand, prepareReview, reviewHead, reviewNumber} from './robin-review-trigger.mjs';

const head = 'a'.repeat(40);
const advanced = 'b'.repeat(40);
const repository = 'suelio-arts/mix-mono';
const repo = {owner: 'suelio-arts', repo: 'mix-mono'};
const target = () => ({number: 7, state: 'open', draft: false, base: {ref: 'main', repo: {full_name: 'suelio-arts/mix-mono'}}, head: {sha: head, repo: {full_name: 'suelio-arts/mix-mono'}}});
const receipt = (kind = 'reviewed', sha = head) => ({user: {login: 'github-actions[bot]', type: 'Bot'}, commit_id: sha, body: `<!-- robin-outcome: v1 ${kind} head=${sha} -->`});
function fixture(eventName = 'pull_request_target') {
    const calls = [];
    const state = {pr: target(), permission: 'write', reviews: []};
    const context = {repo, eventName, ref: 'refs/heads/main', payload: {
        pull_request: target(), issue: {number: 7, pull_request: {}},
        comment: {body: '/robin', user: {login: 'maintainer'}}, inputs: {pr: '7', head},
    }};
    const github = {rest: {
        repos: {getCollaboratorPermissionLevel: async args => {calls.push(['permission', args]); return {data: {permission: state.permission}};}},
        pulls: {get: async args => {calls.push(['pull', args]); return {data: state.pr};}, listReviews: () => {}},
        actions: {createWorkflowDispatch: async args => {calls.push(['dispatch', args]);}},
    }, paginate: async () => {calls.push(['reviews']); return state.reviews;}};
    return {github, context, state, calls};
}

test('inputs and slash command match exact typed boundaries', () => {
    assert.equal(reviewNumber('7'), 7);
    for (const value of ['0', '-1', '7x', '7;sh', '01', '9007199254740992']) assert.throws(() => reviewNumber(value));
    assert.equal(reviewHead(head), head);
    for (const value of ['abc', 'A'.repeat(40), `${head};sh`, null]) assert.throws(() => reviewHead(value));
    for (const body of ['/robin', '/robin\nplease recheck', '/robin recheck']) assert.equal(isReviewCommand(body), true);
    for (const body of ['/robinfoo', 'quoted /robin', ' /robin', null]) assert.equal(isReviewCommand(body), false);
});

test('only open non-draft same-repository main PRs are eligible', () => {
    assert.equal(eligiblePullRequest(target(), repository, head).eligible, true);
    for (const changed of [{state: 'closed'}, {draft: true}, {base: {ref: 'develop'}}, {head: {sha: head, repo: {full_name: 'fork/repo'}}}]) {
        assert.equal(eligiblePullRequest({...target(), ...changed}, repository, head).eligible, false);
    }
    assert.equal(eligiblePullRequest(target(), repository, advanced).reason, 'stale-head');
});

test('dedupe requires bot identity, native commit id, matching last complete marker', () => {
    for (const kind of ['reviewed', 'reused', 'skipped']) assert.equal(hasCompleteReceipt([receipt(kind)], head), true);
    for (const invalid of [receipt('incomplete'), receipt('reviewed', advanced), {...receipt(), commit_id: advanced}, {...receipt(), user: {login: 'maintainer', type: 'User'}}, {...receipt(), body: `${receipt().body}\n${receipt('incomplete').body}`}]) {
        assert.equal(hasCompleteReceipt([invalid], head), false);
    }
});

test('automatic target reads live head and skips an advanced or already covered SHA', async () => {
    const first = fixture();
    assert.equal((await prepareReview(first)).reason, 'dispatched');
    assert.deepEqual(first.calls.at(-1)[1], {...repo, workflow_id: 'robin.yml', ref: 'main', inputs: {pr: '7', head}});
    const moved = fixture();
    moved.state.pr.head.sha = advanced;
    assert.equal((await prepareReview(moved)).reason, 'stale-head');
    assert.deepEqual(moved.calls.map(call => call[0]), ['pull']);
    const covered = fixture();
    covered.state.reviews = [receipt()];
    assert.equal((await prepareReview(covered)).reason, 'already-covered');
    assert.ok(!covered.calls.some(call => call[0] === 'dispatch'));
});

test('ready-for-review PRs with a stale recorded base still dispatch from main', async () => {
    const ready = fixture();
    ready.context.payload.pull_request.base.sha = 'c'.repeat(40);
    assert.equal((await prepareReview(ready)).reason, 'dispatched');
});

test('comment actor permission is checked before fetching or dispatching a PR', async () => {
    for (const permission of ['read', 'triage', 'none', '']) {
        const denied = fixture('issue_comment');
        denied.state.permission = permission;
        await assert.rejects(prepareReview(denied), /write permission/);
        assert.deepEqual(denied.calls.map(call => call[0]), ['permission']);
    }
    const failed = fixture('issue_comment');
    failed.github.rest.repos.getCollaboratorPermissionLevel = async () => {throw new Error('lookup failed');};
    await assert.rejects(prepareReview(failed), /lookup failed/);
    assert.equal(failed.calls.length, 0);
});

test('authorized slash command dispatches only main with current exact head; forks never dispatch', async () => {
    for (const permission of ['write', 'maintain', 'admin']) {
        const command = fixture('issue_comment');
        command.state.permission = permission;
        const result = await prepareReview(command);
        assert.equal(result.reason, 'dispatched');
        assert.equal(result.eligible, false);
        assert.deepEqual(command.calls.at(-1)[1], {...repo, workflow_id: 'robin.yml', ref: 'main', inputs: {pr: '7', head}});
    }
    const fork = fixture('issue_comment');
    fork.state.pr.head.repo.full_name = 'fork/repo';
    assert.equal((await prepareReview(fork)).reason, 'ineligible-target');
    assert.ok(!fork.calls.some(call => call[0] === 'dispatch'));
});

test('dispatch rejects non-main, malformed and moved heads before any review', async () => {
    const wrongBranch = fixture('workflow_dispatch');
    wrongBranch.context.ref = 'refs/heads/untrusted';
    await assert.rejects(prepareReview(wrongBranch), /requires main/);
    assert.equal(wrongBranch.calls.length, 0);
    const malformed = fixture('workflow_dispatch');
    malformed.context.payload.inputs.head = 'abc';
    await assert.rejects(prepareReview(malformed), /full lowercase/);
    assert.equal(malformed.calls.length, 0);
    const moved = fixture('workflow_dispatch');
    moved.state.pr.head.sha = advanced;
    assert.equal((await prepareReview(moved)).reason, 'stale-head');
    const replay = fixture('workflow_dispatch');
    replay.state.reviews = [receipt()];
    assert.equal((await prepareReview(replay)).reason, 'already-covered');
});

test('review-stage revalidation binds the earlier admitted snapshot', async () => {
    const current = fixture('workflow_dispatch');
    current.state.pr.head.sha = advanced;
    assert.equal((await prepareReview({...current, prNumber: '7', expectedHead: head})).reason, 'stale-head');
    const admitted = fixture('workflow_dispatch');
    assert.equal((await prepareReview({...admitted, prNumber: '7', expectedHead: head})).reason, 'review-required');
});

test('a dispatch stops at the round cap, counting only reviewed heads', async () => {
    const heads = ['1', '2', '3'].map(c => c.repeat(40));
    const reviewed = heads.map(sha => receipt('reviewed', sha));
    assert.equal(completedRounds([...reviewed, receipt('reviewed', heads[0])]), 3);
    assert.equal(completedRounds([receipt('skipped', heads[0]), receipt('incomplete', heads[1])]), 0);
    assert.equal(completedRounds([{...receipt('reviewed', heads[0]), user: {login: 'someone', type: 'User'}}]), 0);
    const {github, context, state} = fixture('workflow_dispatch');
    state.reviews = reviewed.slice(0, MAX_REVIEW_ROUNDS - 1);
    assert.equal((await prepareReview({github, context})).reason, 'review-required');
    state.reviews = reviewed;
    const capped = await prepareReview({github, context});
    assert.equal(capped.eligible, false);
    assert.equal(capped.reason, 'round-cap');
});


test('repository context parameterizes all API calls and rejects cross-repository PRs', async () => {
    for (const name of ['mix-place-graph', 'walk-generation-lab', 'mix-app-research', 'mix-canon', 'rolly-brain', 'mix-dev', 'robin-benchmark']) {
        const current = fixture();
        const fullName = `suelio-arts/${name}`;
        current.context.repo = {owner: 'suelio-arts', repo: name};
        current.state.pr.base.repo.full_name = fullName;
        current.state.pr.head.repo.full_name = fullName;
        assert.equal((await prepareReview(current)).reason, 'dispatched');
        assert.deepEqual(current.calls.at(-1)[1], {...current.context.repo, workflow_id: 'robin.yml', ref: 'main', inputs: {pr: '7', head}});
        current.state.pr.base.repo.full_name = repository;
        assert.equal((await prepareReview(current)).reason, 'ineligible-target');
    }
});

'use strict';

const	cronJob = require('cron').CronJob;
const async = require('async');

const winston = require.main.require('winston');
const nconf = require.main.require('nconf');
const db = require.main.require('./src/database');
const topics = require.main.require('./src/topics');
const meta = require.main.require('./src/meta');
const categories = require.main.require('./src/categories');

const Archiver = module.exports;

function isTopicAlreadyDeleted(err) {
	return err && (
		err.code === 'topic-already-deleted' ||
		String(err.message).includes('topic-already-deleted')
	);
}

async function saveLastRun(result) {
	try {
		await meta.settings.set('archiver', {
			lastRun: JSON.stringify(result),
		});
	} catch (err) {
		winston.error(`[plugin.archiver] Unable to save last run result: ${err.message}`);
	}
}

const archiveCron = new cronJob('0 0 0 * * *', (() => {
	winston.verbose('[plugin.archiver] Checking for expired topics');
	Archiver.execute();
}), null, false);

Archiver.start = async (data) => {
	const SocketPlugins = require.main.require('./src/socket.io/plugins');
	SocketPlugins.archiver = require('./websockets');

	function render(req, res, next) {
		categories.getAllCategories(req.user.uid, (err, categories) => {
			if (err) {
				return next();
			}

			categories = categories.map(category => ({
				cid: category.cid,
				name: category.name,
			}));

			res.render('admin/plugins/archiver', {
				categories: categories,
			});
		});
	}

	data.router.get('/admin/plugins/archiver', data.middleware.admin.buildHeader, render);
	data.router.get('/api/admin/plugins/archiver', render);

	const pubsub = require.main.require('./src/pubsub');
	pubsub.on('action:settings.set.archiver', onSettingsSave);

	const { active } = await meta.settings.get('archiver');
	if (active === 'on') {
		reStartCronJobs();
	}
};

function onSettingsSave(data) {
	if (nconf.get('runJobs')) {
		if (data.active === 'on') {
			reStartCronJobs();
		} else {
			stopCronJobs();
		}
	}
}

function reStartCronJobs() {
	if (nconf.get('runJobs')) {
		stopCronJobs();
		archiveCron.start();
	}
}

function stopCronJobs() {
	if (nconf.get('runJobs')) {
		archiveCron.stop();
	}
}

Archiver.findTids = async () => {
	let { cutoff, cids, lowerBound } = await meta.settings.get('archiver');
	cutoff = Date.now() - (60000 * 60 * 24 * parseInt(cutoff || 7, 10));
	lowerBound = lowerBound || 0;

	try {
		if (typeof cids === 'string') {
			cids = JSON.parse(cids).map(cid => parseInt(cid, 10));
		}
	} catch (e) {
		winston.error('[plugins/archiver] Invalid cids value, disabling archiver.');
		cids = [];
	}

	const sets = [];
	if (cids.length) {
		cids.forEach(cid => sets.push(`cid:${cid}:tids`));
	} else {
		sets.push('topics:tid');
	}

	winston.verbose(`[plugins/archiver] Proceeding with sets: ${sets.toString()}`);
	const results = await Promise.all(
		sets.map(async set => await db.getSortedSetRevRangeByScore(set, 0, -1, cutoff, parseInt(lowerBound, 10)))
	);

	return results
		.reduce((memo, cur) => memo.concat(cur))
		.filter((cid, idx, set) => idx === set.indexOf(cid));	// filter dupes
};

Archiver.execute = async () => {
	const now = Date.now();
	const result = {
		status: 'running',
		startedAt: new Date(now).toISOString(),
		finishedAt: null,
		action: null,
		scanned: 0,
		attempted: 0,
		succeeded: 0,
		alreadyDeleted: 0,
		error: null,
	};

	try {
		let { type, cutoff, action, uid, excludePins } = await meta.settings.get('archiver');
		type = type || 'activity';
		cutoff = Date.now() - (60000 * 60 * 24 * parseInt(cutoff, 10));
		action = action || 'lock';
		uid = uid || 1;
		result.action = action;

		let tids = await Archiver.findTids();

		// Filter out topics that do not exist (leftover references in topic zsets?)
		const exists = await topics.exists(tids);
		tids = tids.filter((tid, idx) => exists[idx]);
		result.scanned = tids.length;

		await new Promise((resolve, reject) => {
			async.eachLimit(tids, 5, (tid, next) => {
				topics.getTopicData(tid, (err, topicData) => {
					if (err) {
						return next(err);
					}

					const { timestamp, lastposttime, pinned } = topicData;
					if (excludePins === 'on' && !!pinned) {
						return next();
					}

					const shouldArchive = (type === 'hard' && timestamp <= cutoff) ||
						(type === 'activity' && lastposttime <= cutoff);
					if (!shouldArchive) {
						return process.nextTick(next);
					}

					result.attempted += 1;
					winston.info(`[plugin.archiver] Archiving (${action}) topic ${tid}`);
					return topics.tools[action](tid, uid, (actionErr) => {
						if (isTopicAlreadyDeleted(actionErr)) {
							result.alreadyDeleted += 1;
							winston.warn(`[plugin.archiver] Topic ${tid} is already deleted; skipping.`);
							return next();
						}
						if (actionErr) {
							return next(actionErr);
						}

						result.succeeded += 1;
						return next();
					});
				});
			}, err => (err ? reject(err) : resolve()));
		});

		winston.info('[plugin.archiver] Finished archiving topics.');

		// Update lowerBound
		winston.info(`[plugin.archiver] Updating lower bound value to: ${now}`);
		await meta.settings.set('archiver', {
			lowerBound: now,
		});
		result.status = 'success';
	} catch (err) {
		result.status = 'failed';
		result.error = err.message;
		winston.error(`[plugin.archiver] Unable to archive topics: ${err.message}`);
	}

	result.finishedAt = new Date().toISOString();
	await saveLastRun(result);
	return result;
};

Archiver.getLastRun = async () => {
	const { lastRun } = await meta.settings.get('archiver');
	if (!lastRun) {
		return null;
	}

	try {
		return JSON.parse(lastRun);
	} catch (err) {
		winston.warn(`[plugin.archiver] Invalid last run result: ${err.message}`);
		return null;
	}
};

Archiver.admin = {
	menu: function (custom_header, callback) {
		custom_header.plugins.push({
			route: '/plugins/archiver',
			icon: 'icon-edit',
			name: 'Archiver',
		});

		callback(null, custom_header);
	},
};

module.exports = {
	start: Archiver.start,
	admin: Archiver.admin,
	execute: Archiver.execute,
	findTids: Archiver.findTids,
	getLastRun: Archiver.getLastRun,
};

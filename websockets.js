'use strict';

const meta = require.main.require('./src/meta');

const Archiver = module.parent.exports;

module.exports.test = async () => {
	const { active, action = 'lock' } = await meta.settings.get('archiver');
	const tids = await Archiver.findTids();

	return {
		action,
		tids,
		active: active === 'on',
	};
};

module.exports.status = async () => await Archiver.getLastRun();

module.exports.run = async () => await Archiver.execute();

'use strict';

/* globals $, socket, bootbox, define */

define('admin/plugins/archiver', ['settings', 'alerts'], (Settings, alerts) => {
	const ACP = {};

	function renderLastRun(result) {
		if (!result) {
			$('#last-run-empty').removeClass('d-none');
			$('#last-run-details').addClass('d-none');
			return;
		}

		$('#last-run-empty').addClass('d-none');
		$('#last-run-details').removeClass('d-none');
		$('#last-run-status').text(result.status);
		$('#last-run-started').text(new Date(result.startedAt).toLocaleString());
		$('#last-run-finished').text(new Date(result.finishedAt).toLocaleString());
		$('#last-run-action').text(result.action || '—');
		$('#last-run-scanned').text(result.scanned);
		$('#last-run-attempted').text(result.attempted);
		$('#last-run-succeeded').text(result.succeeded);
		$('#last-run-already-deleted').text(result.alreadyDeleted);
		$('#last-run-error').text(result.error || '—');
	}

	ACP.init = function () {
		Settings.load('archiver', $('.archiver-settings'));

		socket.emit('plugins.archiver.status', {}, (err, result) => {
			if (err) {
				return alerts.error(err.message);
			}
			renderLastRun(result);
		});

		$('#save').on('click', () => {
			Settings.save('archiver', $('.archiver-settings'));
		});


		$('#test').on('click', () => {
			socket.emit('plugins.archiver.test', {}, (err, payload) => {
				if (err) {
					return alerts.error(err.message);
				}

				bootbox.alert(`\
					<p>Archiver is currently: ${payload.active ? 'ENABLED' : 'DISABLED'}</p>\
					<p>When executed, the following tids will be archived: <blockquote>${payload.tids.join(', ')}</blockquote></p>\
					<p>The configured action is to <strong>${payload.action}</strong> the listed tids</p>\
				`);
			});
		});

		$('#execute').on('click', () => {
			bootbox.confirm('Execute archival process now?', (ok) => {
				if (ok) {
					const executeButton = $('#execute');
					executeButton.prop('disabled', true);
					socket.emit('plugins.archiver.run', {}, (err, result) => {
						executeButton.prop('disabled', false);
						if (err) {
							return alerts.error(err.message);
						}

						renderLastRun(result);
						if (result.status === 'failed') {
							return alerts.error(result.error);
						}
						alerts.success('Archiver finished successfully.');
					});
				}
			});
		});
	};

	return ACP;
});

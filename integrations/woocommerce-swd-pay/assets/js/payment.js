/* SWD Pay: draws the Solana Pay QR codes (bundled qrcode-generator, no external service) and polls the order status. */
( function () {
	'use strict';
	var cfg = window.swdPay;
	var box = document.getElementById( 'swd-pay' );
	if ( ! cfg || ! box || typeof window.qrcode !== 'function' ) {
		return;
	}
	var status = box.querySelector( '.swd-pay-status' );

	function drawQr( canvas ) {
		var qr = window.qrcode( 0, 'M' );
		qr.addData( canvas.getAttribute( 'data-url' ) );
		qr.make();
		var n = qr.getModuleCount();
		var margin = 4;
		var size = canvas.width;
		var cell = Math.floor( size / ( n + 2 * margin ) );
		var off = Math.floor( ( size - cell * n ) / 2 );
		var ctx = canvas.getContext( '2d' );
		ctx.fillStyle = '#ffffff';
		ctx.fillRect( 0, 0, size, size );
		ctx.fillStyle = '#000000';
		for ( var r = 0; r < n; r++ ) {
			for ( var c = 0; c < n; c++ ) {
				if ( qr.isDark( r, c ) ) {
					ctx.fillRect( off + c * cell, off + r * cell, cell, cell );
				}
			}
		}
	}
	Array.prototype.forEach.call( box.querySelectorAll( '.swd-pay-qr' ), drawQr );

	// token tabs
	var tabs = box.querySelectorAll( '.swd-pay-tab' );
	Array.prototype.forEach.call( tabs, function ( tab ) {
		tab.addEventListener( 'click', function () {
			Array.prototype.forEach.call( tabs, function ( t ) {
				t.setAttribute( 'aria-selected', t === tab ? 'true' : 'false' );
			} );
			Array.prototype.forEach.call( box.querySelectorAll( '.swd-pay-panel' ), function ( p ) {
				p.hidden = p.getAttribute( 'data-panel' ) !== tab.getAttribute( 'data-tab' );
			} );
		} );
	} );

	// countdown for market-price quotes
	function tick() {
		var now = Math.floor( Date.now() / 1000 );
		Array.prototype.forEach.call( box.querySelectorAll( '.swd-pay-until' ), function ( p ) {
			var left = parseInt( p.getAttribute( 'data-until' ), 10 ) - now;
			if ( left <= 0 ) {
				p.textContent = cfg.i18n.expired;
			} else {
				var m = Math.floor( left / 60 );
				var s = left % 60;
				p.textContent = '\u23F1 ' + m + ':' + ( s < 10 ? '0' : '' ) + s;
			}
		} );
	}
	tick();
	setInterval( tick, 1000 );

	// status polling: every 5 s for 30 min, then every 30 s
	var started = Date.now();
	function poll() {
		var body = new URLSearchParams();
		body.set( 'action', 'swd_pay_status' );
		body.set( 'order_id', String( cfg.orderId ) );
		body.set( 'key', cfg.key );
		body.set( 'nonce', cfg.nonce );
		fetch( cfg.ajaxUrl, { method: 'POST', credentials: 'same-origin', body: body } )
			.then( function ( r ) { return r.json(); } )
			.then( function ( j ) {
				var st = j && j.data && j.data.status;
				if ( st === 'paid' ) {
					status.textContent = cfg.i18n.paid;
					box.classList.add( 'is-paid' );
					setTimeout( function () { window.location.reload(); }, 2500 );
					return;
				}
				status.textContent = st === 'underpaid' ? cfg.i18n.under : st === 'error' ? cfg.i18n.error : cfg.i18n.waiting;
				schedule();
			} )
			.catch( function () {
				status.textContent = cfg.i18n.error;
				schedule();
			} );
	}
	function schedule() {
		setTimeout( poll, Date.now() - started < 30 * 60 * 1000 ? 5000 : 30000 );
	}
	schedule();
}() );

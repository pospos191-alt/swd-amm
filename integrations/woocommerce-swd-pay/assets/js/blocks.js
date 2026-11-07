/* SWD Pay: registers the payment method in the WooCommerce block checkout. Plain script, no build step. */
( function () {
	'use strict';
	var registry = window.wc && window.wc.wcBlocksRegistry;
	var settings = window.wc && window.wc.wcSettings ? window.wc.wcSettings.getSetting( 'swd_pay_data', {} ) : {};
	if ( ! registry || ! window.wp || ! window.wp.element ) {
		return;
	}
	var el = window.wp.element.createElement;
	var decode = window.wp.htmlEntities ? window.wp.htmlEntities.decodeEntities : function ( s ) { return s; };
	var title = decode( settings.title || 'SWD / USDC (Solana Pay)' );
	var Content = function () {
		return el( 'p', null, decode( settings.description || '' ) );
	};
	var Label = function () {
		return el( 'span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
			settings.icon ? el( 'img', { src: settings.icon, alt: '', width: 48, height: 18 } ) : null,
			title
		);
	};
	registry.registerPaymentMethod( {
		name: 'swd_pay',
		label: el( Label ),
		content: el( Content ),
		edit: el( Content ),
		canMakePayment: function () { return true; },
		ariaLabel: title,
		supports: { features: settings.supports || [ 'products' ] }
	} );
}() );

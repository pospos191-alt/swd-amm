<?php
/**
 * The WooCommerce payment gateway: SWD and USDC through Solana Pay.
 *
 * Flow: checkout → the order stays "pending payment" with a unique reference key and a price quote per token →
 * the thank-you page shows a Solana Pay QR / wallet link → the payment is found server-side by asking the merchant's
 * RPC for transactions that carry the reference, and checking recipient, mint, decimals and amount → payment_complete().
 * Nothing in this plugin holds a private key: the merchant only enters a public wallet address.
 *
 * @package SWD_Pay
 */

defined( 'ABSPATH' ) || exit;

/**
 * Gateway.
 */
class SWD_Pay_Gateway extends WC_Payment_Gateway {

	const ID          = 'swd_pay';
	const META_REF    = '_swd_pay_reference';
	const META_QUOTES = '_swd_pay_quotes';
	const META_SIG    = '_swd_pay_signature';
	const META_UNDER  = '_swd_pay_underpaid_signature';
	const CHECK_EVERY = 8;   // Seconds between two RPC checks of one order (status polling).
	const MAX_QUOTES  = 6;   // Quotes kept per order (an earlier, still valid quote can still be paid).
	const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
	const EXPLORER_TX = 'https://solscan.io/tx/';

	/**
	 * Constructor.
	 */
	public function __construct() {
		$this->id                 = self::ID;
		$this->has_fields         = false;
		$this->method_title       = __( 'SWD Pay (Solana Pay: SWD, USDC)', 'swd-pay' );
		$this->method_description = __( 'Accept SWD (SAWASDEE COIN) and USDC on Solana through Solana Pay. Payments go straight to your wallet; the plugin verifies them on-chain through your RPC and marks the order paid.', 'swd-pay' );
		$this->supports           = array( 'products' );
		$this->icon               = SWD_PAY_URL . 'assets/swd-pay.svg';

		$this->init_form_fields();
		$this->init_settings();
		$this->title       = $this->get_option( 'title' );
		$this->description = $this->get_option( 'description' );
		$this->enabled     = $this->get_option( 'enabled' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
		add_action( 'woocommerce_thankyou_' . $this->id, array( $this, 'payment_box' ) );
		add_action( 'woocommerce_view_order', array( $this, 'view_order_box' ), 5 );
	}

	/**
	 * Settings.
	 */
	public function init_form_fields() {
		$usd               = function_exists( 'get_woocommerce_currency' ) && 'USD' === get_woocommerce_currency();
		$this->form_fields = array(
			'enabled'       => array(
				'title'   => __( 'Enable', 'swd-pay' ),
				'type'    => 'checkbox',
				'label'   => __( 'Accept SWD / USDC with Solana Pay', 'swd-pay' ),
				'default' => 'no',
			),
			'title'         => array(
				'title'   => __( 'Title', 'swd-pay' ),
				'type'    => 'text',
				'default' => __( 'Pay with SWD or USDC (Solana Pay)', 'swd-pay' ),
			),
			'description'   => array(
				'title'   => __( 'Description', 'swd-pay' ),
				'type'    => 'textarea',
				'default' => __( 'After you place the order, scan the QR code with a Solana wallet (Phantom, Solflare, ...) or open the link on your phone.', 'swd-pay' ),
			),
			'wallet'        => array(
				'title'       => __( 'Your Solana wallet address', 'swd-pay' ),
				'type'        => 'text',
				'description' => __( 'The PUBLIC address that receives payments. Never enter a private key or seed phrase anywhere in WordPress.', 'swd-pay' ),
				'default'     => '',
			),
			'rpc_url'       => array(
				'title'       => __( 'Solana RPC URL', 'swd-pay' ),
				'type'        => 'text',
				'description' => __( 'Used to verify payments (https only). The public endpoint is rate-limited; use your own (Helius, QuickNode, Triton, ...) for a real shop.', 'swd-pay' ),
				'default'     => self::DEFAULT_RPC,
			),
			'commitment'    => array(
				'title'   => __( 'Confirmation level', 'swd-pay' ),
				'type'    => 'select',
				'options' => array(
					'confirmed' => __( 'Confirmed (about 1 second)', 'swd-pay' ),
					'finalized' => __( 'Finalized (about 15 seconds, safest)', 'swd-pay' ),
				),
				'default' => 'confirmed',
			),
			'accept_swd'    => array(
				'title'   => __( 'Accept SWD', 'swd-pay' ),
				'type'    => 'checkbox',
				'label'   => 'SWD — Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL',
				'default' => 'yes',
			),
			'accept_usdc'   => array(
				'title'   => __( 'Accept USDC', 'swd-pay' ),
				'type'    => 'checkbox',
				'label'   => 'USDC — EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				'default' => 'yes',
			),
			'pricing'       => array(
				'title'       => __( 'Price conversion', 'swd-pay' ),
				'type'        => 'select',
				'options'     => array(
					'fixed'   => __( 'Fixed rate (set below)', 'swd-pay' ),
					'jupiter' => __( 'Market price (Jupiter Price API, USD)', 'swd-pay' ),
				),
				'default'     => 'fixed',
				'description' => __( 'Market quotes expire after the quote validity below; a fixed rate never expires.', 'swd-pay' ),
			),
			'price_swd'     => array(
				'title'       => __( 'Fixed rate: store currency per 1 SWD', 'swd-pay' ),
				'type'        => 'text',
				'description' => __( 'e.g. 0.05 means 1 SWD = 0.05 in your store currency. Up to 12 decimals.', 'swd-pay' ),
				'default'     => '',
			),
			'price_usdc'    => array(
				'title'       => __( 'Fixed rate: store currency per 1 USDC', 'swd-pay' ),
				'type'        => 'text',
				'description' => __( 'For a USD store this is 1. For THB, the THB/USD rate (e.g. 36.5).', 'swd-pay' ),
				'default'     => $usd ? '1' : '',
			),
			'usd_rate'      => array(
				'title'       => __( 'Market price: store currency per 1 USD', 'swd-pay' ),
				'type'        => 'text',
				'description' => __( 'Jupiter prices are in USD. For a USD store this is 1; for THB, the THB/USD rate.', 'swd-pay' ),
				'default'     => '1',
			),
			'quote_minutes' => array(
				'title'             => __( 'Quote validity (minutes)', 'swd-pay' ),
				'type'              => 'number',
				'default'           => '15',
				'custom_attributes' => array(
					'min' => '5',
					'max' => '120',
				),
			),
			'label'         => array(
				'title'       => __( 'Name shown in the wallet', 'swd-pay' ),
				'type'        => 'text',
				'default'     => get_bloginfo( 'name' ),
				'description' => __( 'The Solana Pay "label". Visible to the customer before they approve.', 'swd-pay' ),
			),
			'debug'         => array(
				'title'   => __( 'Debug log', 'swd-pay' ),
				'type'    => 'checkbox',
				'label'   => __( 'Log RPC checks to WooCommerce → Status → Logs (no personal data)', 'swd-pay' ),
				'default' => 'no',
			),
		);
	}

	// ---- settings validation (WC calls validate_<key>_field when the settings form is saved) ----

	/**
	 * Wallet.
	 *
	 * @param string $key   Key.
	 * @param string $value Value.
	 * @return string
	 */
	public function validate_wallet_field( $key, $value ) {
		$value = trim( sanitize_text_field( (string) $value ) );
		if ( '' !== $value && ! SWD_Pay_Math::is_address( $value ) ) {
			WC_Admin_Settings::add_error( __( 'SWD Pay: the wallet is not a valid Solana address.', 'swd-pay' ) );
			return $this->get_option( 'wallet' );
		}
		return $value;
	}

	/**
	 * RPC URL.
	 *
	 * @param string $key   Key.
	 * @param string $value Value.
	 * @return string
	 */
	public function validate_rpc_url_field( $key, $value ) {
		$value = esc_url_raw( trim( (string) $value ), array( 'https' ) );
		if ( '' === $value || 0 !== strpos( $value, 'https://' ) ) {
			WC_Admin_Settings::add_error( __( 'SWD Pay: the RPC URL must start with https://.', 'swd-pay' ) );
			return $this->get_option( 'rpc_url', self::DEFAULT_RPC );
		}
		return $value;
	}

	/**
	 * A decimal rate.
	 *
	 * @param string $key   Key.
	 * @param string $value Value.
	 * @return string
	 */
	private function decimal_field( $key, $value ) {
		$value = trim( str_replace( ',', '.', sanitize_text_field( (string) $value ) ) );
		if ( '' !== $value && ( ! SWD_Pay_Math::is_decimal( $value, 12 ) || '0' === SWD_Pay_Math::scale( $value, 12 ) ) ) {
			/* translators: %s: setting name */
			WC_Admin_Settings::add_error( sprintf( __( 'SWD Pay: "%s" must be a positive number with at most 12 decimals.', 'swd-pay' ), $this->form_fields[ $key ]['title'] ) );
			return $this->get_option( $key );
		}
		return $value;
	}

	/**
	 * SWD rate.
	 *
	 * @param string $key   Key.
	 * @param string $value Value.
	 * @return string
	 */
	public function validate_price_swd_field( $key, $value ) {
		return $this->decimal_field( $key, $value );
	}

	/**
	 * USDC rate.
	 *
	 * @param string $key   Key.
	 * @param string $value Value.
	 * @return string
	 */
	public function validate_price_usdc_field( $key, $value ) {
		return $this->decimal_field( $key, $value );
	}

	/**
	 * USD rate.
	 *
	 * @param string $key   Key.
	 * @param string $value Value.
	 * @return string
	 */
	public function validate_usd_rate_field( $key, $value ) {
		return $this->decimal_field( $key, $value );
	}

	// ---- checkout ----

	/**
	 * Shown only when it can actually take a payment.
	 *
	 * @return bool
	 */
	public function is_available() {
		if ( ! parent::is_available() || ! SWD_Pay_Math::is_address( $this->get_option( 'wallet' ) ) ) {
			return false;
		}
		$s = $this->settings;
		if ( 'fixed' === $this->get_option( 'pricing' ) ) {
			$ok = ( 'yes' === $this->get_option( 'accept_swd' ) && null !== SWD_Pay_Price::unit_price( 'swd', $s ) )
				|| ( 'yes' === $this->get_option( 'accept_usdc' ) && null !== SWD_Pay_Price::unit_price( 'usdc', $s ) );
			return $ok;
		}
		return 'yes' === $this->get_option( 'accept_swd' ) || 'yes' === $this->get_option( 'accept_usdc' );
	}

	/**
	 * Places the order: reference key + quotes, then the thank-you page shows how to pay.
	 *
	 * @param int $order_id Order.
	 * @return array
	 */
	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			return array( 'result' => 'failure' );
		}
		if ( ! $this->ensure_quotes( $order, true ) ) {
			wc_add_notice( __( 'Crypto prices are not available right now. Please try again in a minute or choose another payment method.', 'swd-pay' ), 'error' );
			return array( 'result' => 'failure' );
		}
		$order->update_status( 'pending', __( 'Awaiting a Solana Pay payment (SWD / USDC).', 'swd-pay' ) );
		if ( function_exists( 'WC' ) && WC()->cart ) {
			WC()->cart->empty_cart();
		}
		return array(
			'result'   => 'success',
			'redirect' => $this->get_return_url( $order ),
		);
	}

	/**
	 * Makes sure the order has a reference and a current quote. Keeps a few earlier quotes (still payable until they
	 * expire, so a customer who paid just before a re-quote is not refused).
	 *
	 * @param WC_Order $order Order.
	 * @param bool     $force New quotes even if the current ones are valid.
	 * @return bool
	 */
	public function ensure_quotes( $order, $force = false ) {
		if ( ! $order->get_meta( self::META_REF ) ) {
			$order->update_meta_data( self::META_REF, SWD_Pay_Math::new_reference() );
		}
		$all        = $this->order_quotes( $order );
		$now        = time();
		$current    = array_filter(
			$all,
			function ( $q ) use ( $now ) {
				return empty( $q['until'] ) || $q['until'] > $now + 60;
			}
		);
		$same_total = ! empty( $all ) && end( $all )['total'] === $this->order_total( $order );
		if ( ! $force && $current && $same_total ) {
			$order->save();
			return true;
		}
		$fresh = SWD_Pay_Price::quotes( $this->order_total( $order ), $this->settings, $now );
		if ( ! $fresh ) {
			$order->save();
			return ! empty( $current ) && $same_total;
		}
		foreach ( $fresh as &$q ) {
			$q['total']    = $this->order_total( $order );
			$q['currency'] = $order->get_currency();
		}
		unset( $q );
		$keep = array_slice( array_merge( $all, $fresh ), -self::MAX_QUOTES );
		$order->update_meta_data( self::META_QUOTES, wp_json_encode( array_values( $keep ) ) );
		$order->save();
		return true;
	}

	/**
	 * The order total as a decimal string.
	 *
	 * @param WC_Order $order Order.
	 * @return string
	 */
	private function order_total( $order ) {
		return wc_format_decimal( $order->get_total(), wc_get_price_decimals() );
	}

	/**
	 * Stored quotes.
	 *
	 * @param WC_Order $order Order.
	 * @return array
	 */
	public function order_quotes( $order ) {
		$q = json_decode( (string) $order->get_meta( self::META_QUOTES ), true );
		return is_array( $q ) ? $q : array();
	}

	/**
	 * The newest quote per token (what the payment box shows).
	 *
	 * @param WC_Order $order Order.
	 * @return array
	 */
	private function latest_quotes( $order ) {
		$by = array();
		foreach ( $this->order_quotes( $order ) as $q ) {
			$by[ $q['key'] ] = $q;
		}
		return array_values( $by );
	}

	// ---- payment box (thank-you page, "view order") ----

	/**
	 * Thank-you page.
	 *
	 * @param int $order_id Order.
	 */
	public function payment_box( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order || self::ID !== $order->get_payment_method() ) {
			return;
		}
		if ( $order->is_paid() ) {
			$this->paid_notice( $order );
			return;
		}
		if ( ! $order->needs_payment() ) {
			return;
		}
		$this->ensure_quotes( $order );
		$quotes = $this->latest_quotes( $order );
		if ( ! $quotes ) {
			echo '<p class="woocommerce-error">' . esc_html__( 'Crypto prices are not available right now. Please reload this page in a minute.', 'swd-pay' ) . '</p>';
			return;
		}
		$ref    = (string) $order->get_meta( self::META_REF );
		$wallet = $this->get_option( 'wallet' );
		$label  = $this->get_option( 'label' ) ? $this->get_option( 'label' ) : get_bloginfo( 'name' );
		/* translators: %s: order number */
		$message = sprintf( __( 'Order #%s', 'swd-pay' ), $order->get_order_number() );

		wp_enqueue_style( 'swd-pay', SWD_PAY_URL . 'assets/css/payment.css', array(), SWD_PAY_VERSION );
		wp_enqueue_script( 'swd-pay-qrcode', SWD_PAY_URL . 'assets/js/vendor/qrcode-generator.js', array(), '2.0.4', true );
		wp_enqueue_script( 'swd-pay', SWD_PAY_URL . 'assets/js/payment.js', array( 'swd-pay-qrcode' ), SWD_PAY_VERSION, true );
		wp_localize_script(
			'swd-pay',
			'swdPay',
			array(
				'ajaxUrl' => admin_url( 'admin-ajax.php' ),
				'orderId' => $order->get_id(),
				'key'     => $order->get_order_key(),
				'nonce'   => wp_create_nonce( 'swd_pay_status_' . $order->get_id() ),
				'i18n'    => array(
					'paid'    => __( 'Payment received. Thank you!', 'swd-pay' ),
					'waiting' => __( 'Waiting for the payment…', 'swd-pay' ),
					'under'   => __( 'A payment arrived but it is less than the amount due. Please contact the shop.', 'swd-pay' ),
					'expired' => __( 'This price has expired. Reload the page for a new one.', 'swd-pay' ),
					'error'   => __( 'Could not check the payment right now; retrying…', 'swd-pay' ),
				),
			)
		);

		echo '<section class="swd-pay" id="swd-pay">';
		echo '<h2>' . esc_html__( 'Pay with Solana Pay', 'swd-pay' ) . '</h2>';
		echo '<p>' . esc_html__( 'Choose a token, then scan the QR code with your Solana wallet, or tap "Open in wallet" on your phone. Send the exact amount shown; the order updates automatically.', 'swd-pay' ) . '</p>';
		echo '<div class="swd-pay-tabs" role="tablist">';
		foreach ( $quotes as $i => $q ) {
			printf(
				'<button type="button" role="tab" class="swd-pay-tab" data-tab="%1$s" aria-selected="%2$s">%3$s</button>',
				esc_attr( $q['key'] ),
				0 === $i ? 'true' : 'false',
				esc_html( $q['symbol'] )
			);
		}
		echo '</div>';
		foreach ( $quotes as $i => $q ) {
			$url = SWD_Pay_Price::solana_pay_url( $wallet, $q, $ref, $label, $message );
			printf( '<div class="swd-pay-panel" data-panel="%1$s"%2$s>', esc_attr( $q['key'] ), 0 === $i ? '' : ' hidden' );
			printf( '<canvas class="swd-pay-qr" width="264" height="264" data-url="%s" aria-label="%s"></canvas>', esc_attr( $url ), esc_attr__( 'Solana Pay QR code', 'swd-pay' ) );
			echo '<p class="swd-pay-amount"><strong>' . esc_html( $q['amount'] . ' ' . $q['symbol'] ) . '</strong></p>';
			/* translators: 1: price, 2: currency code, 3: token symbol */
			echo '<p class="swd-pay-rate">' . esc_html( sprintf( __( 'Rate: %1$s %2$s per %3$s', 'swd-pay' ), $q['price'], $q['currency'], $q['symbol'] ) ) . '</p>';
			if ( ! empty( $q['until'] ) ) {
				printf( '<p class="swd-pay-until" data-until="%d"></p>', (int) $q['until'] );
			}
			echo '<p><a class="button swd-pay-open" href="' . esc_url( $url, array( 'solana' ) ) . '">' . esc_html__( 'Open in wallet', 'swd-pay' ) . '</a></p>';
			echo '<details><summary>' . esc_html__( 'Pay manually', 'swd-pay' ) . '</summary><dl>';
			echo '<dt>' . esc_html__( 'To', 'swd-pay' ) . '</dt><dd><code>' . esc_html( $wallet ) . '</code></dd>';
			echo '<dt>' . esc_html__( 'Token', 'swd-pay' ) . '</dt><dd><code>' . esc_html( $q['mint'] ) . '</code></dd>';
			echo '<dt>' . esc_html__( 'Amount', 'swd-pay' ) . '</dt><dd><code>' . esc_html( $q['amount'] ) . '</code></dd>';
			echo '</dl><p>' . esc_html__( 'A manual transfer cannot carry the order reference, so it is not detected automatically: please use the QR code or the wallet link whenever you can.', 'swd-pay' ) . '</p></details>';
			echo '</div>';
		}
		echo '<p class="swd-pay-status" role="status" aria-live="polite">' . esc_html__( 'Waiting for the payment…', 'swd-pay' ) . '</p>';
		echo '</section>';
	}

	/**
	 * My account → view order.
	 *
	 * @param int $order_id Order.
	 */
	public function view_order_box( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( $order && self::ID === $order->get_payment_method() && $order->needs_payment() ) {
			$this->payment_box( $order_id );
		}
	}

	/**
	 * After payment.
	 *
	 * @param WC_Order $order Order.
	 */
	private function paid_notice( $order ) {
		$sig = (string) $order->get_meta( self::META_SIG );
		echo '<p class="woocommerce-message">' . esc_html__( 'Payment received on Solana.', 'swd-pay' );
		if ( $sig ) {
			echo ' <a href="' . esc_url( self::EXPLORER_TX . rawurlencode( $sig ) ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'View transaction', 'swd-pay' ) . '</a>';
		}
		echo '</p>';
	}

	// ---- verification ----

	/**
	 * Asks the RPC whether the order is paid; completes it if so.
	 *
	 * @param WC_Order $order Order.
	 * @return string paid | underpaid | pending | error
	 */
	public function check_order( $order ) {
		if ( $order->is_paid() ) {
			return 'paid';
		}
		$ref    = (string) $order->get_meta( self::META_REF );
		$wallet = $this->get_option( 'wallet' );
		$quotes = $this->order_quotes( $order );
		if ( ! SWD_Pay_Math::is_address( $ref ) || ! SWD_Pay_Math::is_address( $wallet ) || ! $quotes ) {
			return 'error';
		}
		$order_id = $order->get_id();
		$rpc      = new SWD_Pay_Solana( $this->get_option( 'rpc_url', self::DEFAULT_RPC ), $this->get_option( 'commitment', 'confirmed' ) );
		try {
			$found = $rpc->find_payment(
				array(
					'reference'  => $ref,
					'recipient'  => $wallet,
					'quotes'     => $quotes,
					'not_before' => $order->get_date_created() ? $order->get_date_created()->getTimestamp() : 0,
					'used'       => function ( $sig ) use ( $order_id ) {
						return self::signature_used_elsewhere( $sig, $order_id );
					},
				)
			);
		} catch ( Exception $e ) {
			$this->log( 'order ' . $order_id . ': rpc error' );
			return 'error';
		}
		$this->log( 'order ' . $order_id . ': ' . $found['status'] );
		if ( 'paid' === $found['status'] ) {
			// Re-read: another request (cron / poll) may have completed it meanwhile.
			$fresh = wc_get_order( $order_id );
			if ( $fresh && $fresh->is_paid() ) {
				return 'paid';
			}
			$symbol = $this->symbol_of( $found['mint'] );
			$order->update_meta_data( self::META_SIG, $found['signature'] );
			$order->add_order_note(
				sprintf(
					/* translators: 1: amount, 2: token symbol, 3: explorer URL */
					__( 'Solana Pay payment verified: %1$s %2$s. Transaction: %3$s', 'swd-pay' ),
					SWD_Pay_Math::format_raw( $found['received'], $this->decimals_of( $found['mint'] ) ),
					$symbol,
					self::EXPLORER_TX . $found['signature']
				)
			);
			$order->payment_complete( $found['signature'] );
			return 'paid';
		}
		if ( 'underpaid' === $found['status'] && $order->get_meta( self::META_UNDER ) !== $found['signature'] ) {
			$order->update_meta_data( self::META_UNDER, $found['signature'] );
			$order->add_order_note(
				sprintf(
					/* translators: 1: amount, 2: token symbol, 3: explorer URL */
					__( 'Solana Pay: a payment of %1$s %2$s arrived but is LESS than the amount due. The order was not marked paid. Transaction: %3$s', 'swd-pay' ),
					SWD_Pay_Math::format_raw( $found['received'], $this->decimals_of( $found['mint'] ) ),
					$this->symbol_of( $found['mint'] ),
					self::EXPLORER_TX . $found['signature']
				)
			);
			$order->save();
		}
		return $found['status'];
	}

	/**
	 * True when another order already used this transaction signature.
	 *
	 * @param string $sig      Signature.
	 * @param int    $order_id This order.
	 * @return bool
	 */
	public static function signature_used_elsewhere( $sig, $order_id ) {
		$ids = wc_get_orders(
			array(
				'limit'      => 2,
				'return'     => 'ids',
				'status'     => 'any',
				'meta_query' => array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query -- one indexed lookup per new signature
					array(
						'key'   => self::META_SIG,
						'value' => $sig,
					),
				),
			)
		);
		foreach ( $ids as $id ) {
			if ( (int) $id !== (int) $order_id ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Token symbol.
	 *
	 * @param string $mint Mint.
	 * @return string
	 */
	private function symbol_of( $mint ) {
		foreach ( SWD_Pay_Price::tokens() as $t ) {
			if ( $t['mint'] === $mint ) {
				return $t['symbol'];
			}
		}
		return '?';
	}

	/**
	 * Token decimals.
	 *
	 * @param string $mint Mint.
	 * @return int
	 */
	private function decimals_of( $mint ) {
		foreach ( SWD_Pay_Price::tokens() as $t ) {
			if ( $t['mint'] === $mint ) {
				return $t['decimals'];
			}
		}
		return 0;
	}

	/**
	 * Debug log (order ids and statuses only).
	 *
	 * @param string $msg Message.
	 */
	private function log( $msg ) {
		if ( 'yes' === $this->get_option( 'debug' ) && function_exists( 'wc_get_logger' ) ) {
			wc_get_logger()->info( $msg, array( 'source' => 'swd-pay' ) );
		}
	}

	// ---- endpoints / cron (registered in the main plugin file) ----

	/**
	 * The gateway instance WooCommerce loaded.
	 *
	 * @return SWD_Pay_Gateway|null
	 */
	public static function instance() {
		if ( ! function_exists( 'WC' ) || ! WC()->payment_gateways() ) {
			return null;
		}
		$all = WC()->payment_gateways()->payment_gateways();
		return isset( $all[ self::ID ] ) ? $all[ self::ID ] : null;
	}

	/**
	 * AJAX: the payment page asks whether the order is paid. Needs the page's nonce AND the order key.
	 */
	public static function ajax_status() {
		$order_id = isset( $_POST['order_id'] ) ? absint( wp_unslash( $_POST['order_id'] ) ) : 0;
		check_ajax_referer( 'swd_pay_status_' . $order_id, 'nonce' );
		$key   = isset( $_POST['key'] ) ? sanitize_text_field( wp_unslash( $_POST['key'] ) ) : '';
		$order = $order_id ? wc_get_order( $order_id ) : null;
		if ( ! $order || self::ID !== $order->get_payment_method() || ! hash_equals( $order->get_order_key(), $key ) ) {
			wp_send_json_error( array( 'status' => 'not_found' ), 404 );
		}
		if ( $order->is_paid() ) {
			wp_send_json_success( array( 'status' => 'paid' ) );
		}
		if ( ! $order->needs_payment() ) {
			wp_send_json_success( array( 'status' => $order->get_status() ) );
		}
		// At most one RPC check per order every CHECK_EVERY seconds, however many tabs poll.
		$lock = 'swd_pay_chk_' . $order_id;
		if ( get_transient( $lock ) ) {
			wp_send_json_success( array( 'status' => 'pending' ) );
		}
		set_transient( $lock, 1, self::CHECK_EVERY );
		$gw = self::instance();
		wp_send_json_success( array( 'status' => $gw ? $gw->check_order( $order ) : 'error' ) );
	}

	/**
	 * Cron: checks recent unpaid orders, so a payment is recorded even if the customer closed the page.
	 */
	public static function cron_check() {
		$gw = self::instance();
		if ( ! $gw || 'yes' !== $gw->enabled ) {
			return;
		}
		$orders = wc_get_orders(
			array(
				'limit'          => 50,
				'payment_method' => self::ID,
				'status'         => array( 'pending', 'on-hold' ),
				'date_created'   => '>' . ( time() - 2 * DAY_IN_SECONDS ),
				'orderby'        => 'date',
				'order'          => 'DESC',
			)
		);
		foreach ( $orders as $order ) {
			$gw->check_order( $order );
		}
	}

	/**
	 * Admin order action "Check Solana Pay payment now".
	 *
	 * @param array $actions Actions.
	 * @return array
	 */
	public static function order_actions( $actions ) {
		global $theorder;
		if ( $theorder instanceof WC_Order && self::ID === $theorder->get_payment_method() && ! $theorder->is_paid() ) {
			$actions['swd_pay_check'] = __( 'Check Solana Pay payment now', 'swd-pay' );
		}
		return $actions;
	}

	/**
	 * Runs the admin order action (WooCommerce already checked the order-edit nonce).
	 *
	 * @param WC_Order $order Order.
	 */
	public static function order_action_check( $order ) {
		if ( ! current_user_can( 'edit_shop_orders' ) ) { // phpcs:ignore WordPress.WP.Capabilities.Unknown -- a WooCommerce capability.
			return;
		}
		$gw = self::instance();
		if ( $gw ) {
			/* translators: %s: status */
			$order->add_order_note( sprintf( __( 'Manual Solana Pay check: %s', 'swd-pay' ), $gw->check_order( $order ) ) );
		}
	}
}

<?php
/**
 * Block checkout support: the payment method's title and description. The QR code is shown after the order is
 * placed (thank-you page), so the block needs no fields.
 *
 * @package SWD_Pay
 */

defined( 'ABSPATH' ) || exit;

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

/**
 * Block integration.
 */
final class SWD_Pay_Blocks extends AbstractPaymentMethodType {

	/**
	 * Payment method name (= gateway id).
	 *
	 * @var string
	 */
	protected $name = 'swd_pay';

	/**
	 * Loads the settings.
	 */
	public function initialize() {
		$this->settings = get_option( 'woocommerce_swd_pay_settings', array() );
	}

	/**
	 * Active when the gateway is.
	 *
	 * @return bool
	 */
	public function is_active() {
		$gw = SWD_Pay_Gateway::instance();
		return $gw ? $gw->is_available() : false;
	}

	/**
	 * Script.
	 *
	 * @return string[]
	 */
	public function get_payment_method_script_handles() {
		wp_register_script(
			'swd-pay-blocks',
			SWD_PAY_URL . 'assets/js/blocks.js',
			array( 'wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities' ),
			SWD_PAY_VERSION,
			true
		);
		return array( 'swd-pay-blocks' );
	}

	/**
	 * Data for the script.
	 *
	 * @return array
	 */
	public function get_payment_method_data() {
		return array(
			'title'       => $this->get_setting( 'title', __( 'Pay with SWD or USDC (Solana Pay)', 'swd-pay' ) ),
			'description' => $this->get_setting( 'description' ),
			'icon'        => SWD_PAY_URL . 'assets/swd-pay.svg',
			'supports'    => array( 'products' ),
		);
	}
}

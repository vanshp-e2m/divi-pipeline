<?php
/**
 * Plugin Name: f2d Bridge (figma2divi)
 * Description: Companion plugin for the figma2divi pipeline: blank canvas template for generated pages, signed draft previews on non-production sites, WP-CLI deploy / readback / rollback / cache / media commands.
 * Version: 0.3.1
 * Requires PHP: 7.4
 * Author: figma2divi
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'F2D_BRIDGE_VERSION', '0.3.1' );
define( 'F2D_META_BUILD', '_f2d_build' );       // JSON: { build_id, page_key, deployed_at, divi_version }
define( 'F2D_META_KEY', '_f2d_page_key' );      // stable identity of a generated page
define( 'F2D_META_HISTORY', '_f2d_history' );   // array of snapshots for rollback
define( 'F2D_HISTORY_MAX', 20 );

function f2d_is_generated( $post_id ) {
	return (bool) get_post_meta( $post_id, F2D_META_KEY, true );
}

function f2d_preview_allowed() {
	return in_array( wp_get_environment_type(), array( 'local', 'development', 'staging' ), true );
}

function f2d_secret() {
	$s = get_option( 'f2d_bridge_secret' );
	if ( ! $s ) {
		$s = wp_generate_password( 48, false, false );
		update_option( 'f2d_bridge_secret', $s, false );
	}
	return $s;
}

function f2d_preview_token( $post_id ) {
	return substr( hash_hmac( 'sha256', 'f2d-preview|' . (int) $post_id, f2d_secret() ), 0, 32 );
}

/* ---------------------------------------------------------------- template */

// Generated pages render on a blank canvas: wp_head, the Divi content, wp_footer — no theme
// header/footer (block themes would otherwise wrap the design in their template parts).
add_filter(
	'template_include',
	function ( $template ) {
		if ( is_singular() && f2d_is_generated( get_queried_object_id() ) ) {
			return __DIR__ . '/templates/canvas.php';
		}
		return $template;
	},
	99
);

add_filter(
	'body_class',
	function ( $classes ) {
		if ( is_singular() && f2d_is_generated( get_queried_object_id() ) ) {
			$classes[] = 'f2d-page';
		}
		return $classes;
	}
);

/* ---------------------------------------------------------------- divi critical css */

// Divi's Critical CSS defers all page styles below an above-the-fold guess, which paints generated
// pages unstyled first (measured CLS 0.22). Disable it for generated pages only, through Divi's own
// public API (ET_Builder_Critical_CSS::disable, since 4.12). Other pages keep the site setting.
add_action(
	'wp',
	function () {
		if ( is_singular() && f2d_is_generated( get_queried_object_id() ) && class_exists( 'ET_Builder_Critical_CSS' ) && method_exists( 'ET_Builder_Critical_CSS', 'instance' ) ) {
			ET_Builder_Critical_CSS::instance()->disable();
		}
	},
	1
);

/* ---------------------------------------------------------------- exact text */

// Generated content is exact HTML. wptexturize turns ' into ’; wpautop injects empty <p> and <br>
// between elements, which become extra flex items (one extra gap each). Both are off for generated
// pages only.
add_action(
	'wp',
	function () {
		if ( is_singular() && f2d_is_generated( get_queried_object_id() ) ) {
			add_filter( 'run_wptexturize', '__return_false' );
			remove_filter( 'the_content', 'wpautop' );
		}
	},
	1
);

/* ---------------------------------------------------------------- fonts */

// Font stylesheets recorded by the build (Google CSS URLs or uploaded @font-face CSS files),
// enqueued once per generated page.
add_action(
	'wp_enqueue_scripts',
	function () {
		if ( ! is_singular() ) {
			return;
		}
		$id = get_queried_object_id();
		if ( ! f2d_is_generated( $id ) ) {
			return;
		}
		$urls = json_decode( (string) get_post_meta( $id, '_f2d_font_urls', true ), true );
		foreach ( (array) $urls as $i => $u ) {
			if ( is_string( $u ) && preg_match( '#^https?://#', $u ) ) {
				wp_enqueue_style( 'f2d-font-' . $i, $u, array(), null );
			}
		}
		// Menu, accordion, slider and ticker behaviour for the components the compiler marked.
		wp_enqueue_script( 'f2d-runtime', plugins_url( 'assets/f2d-runtime.js', __FILE__ ), array(), F2D_BRIDGE_VERSION, true );
	}
);

// The runtime's state styles key off html.f2d-js; set it before first paint so a collapsed mobile
// menu or accordion never renders open first and then jumps (layout shift).
add_action(
	'wp_head',
	function () {
		if ( is_singular() && f2d_is_generated( get_queried_object_id() ) ) {
			echo "<script>document.documentElement.classList.add('f2d-js');</script>\n";
		}
	},
	1
);

/* ---------------------------------------------------------------- signed draft preview */

// ?f2d_preview=<token> shows a generated draft without logging in — only on local/dev/staging,
// only for generated pages, only with the HMAC token for that post id.
add_filter(
	'posts_results',
	function ( $posts, $query ) {
		if ( ! $query->is_main_query() || empty( $_GET['f2d_preview'] ) || count( $posts ) !== 1 || ! f2d_preview_allowed() ) {
			return $posts;
		}
		$p = $posts[0];
		if ( in_array( $p->post_status, array( 'draft', 'pending', 'private' ), true )
			&& f2d_is_generated( $p->ID )
			&& hash_equals( f2d_preview_token( $p->ID ), sanitize_text_field( wp_unslash( $_GET['f2d_preview'] ) ) ) ) {
			$p->post_status = 'publish';
			add_filter( 'wp_robots', 'wp_robots_no_robots' );
		}
		return $posts;
	},
	10,
	2
);

/* ---------------------------------------------------------------- svg + font uploads (CLI only) */

function f2d_cli_mimes() {
	return array(
		'svg'   => 'image/svg+xml',
		'woff2' => 'font/woff2',
		'woff'  => 'font/woff',
		'ttf'   => 'font/ttf',
		'otf'   => 'font/otf',
	);
}
add_filter(
	'upload_mimes',
	function ( $mimes ) {
		if ( defined( 'WP_CLI' ) && WP_CLI ) {
			$mimes = array_merge( $mimes, f2d_cli_mimes() );
		}
		return $mimes;
	}
);
add_filter(
	'wp_check_filetype_and_ext',
	function ( $data, $file, $filename ) {
		$ext = strtolower( pathinfo( $filename, PATHINFO_EXTENSION ) );
		$map = f2d_cli_mimes();
		if ( defined( 'WP_CLI' ) && WP_CLI && isset( $map[ $ext ] ) ) {
			$data = array( 'ext' => $ext, 'type' => $map[ $ext ], 'proper_filename' => false );
		}
		return $data;
	},
	10,
	3
);

/* ---------------------------------------------------------------- core operations */

function f2d_admin_user() {
	$admins = get_users( array( 'role' => 'administrator', 'number' => 1, 'orderby' => 'ID' ) );
	return $admins ? $admins[0]->ID : 0;
}

function f2d_as_admin() {
	// Divi's cache clearing and unfiltered post content both require a privileged user.
	if ( ! get_current_user_id() ) {
		wp_set_current_user( f2d_admin_user() );
	}
	kses_remove_filters();
}

function f2d_find_page( $page_key ) {
	$q = get_posts(
		array(
			'post_type'      => 'page',
			'post_status'    => array( 'draft', 'publish', 'pending', 'private' ),
			'meta_key'       => F2D_META_KEY,
			'meta_value'     => $page_key,
			'posts_per_page' => 2,
			'fields'         => 'ids',
		)
	);
	if ( count( $q ) > 1 ) {
		return new WP_Error( 'f2d_duplicate', "More than one page has f2d key {$page_key}: " . implode( ',', $q ) );
	}
	return $q ? (int) $q[0] : 0;
}

function f2d_divi_version() {
	return defined( 'ET_BUILDER_PRODUCT_VERSION' ) ? ET_BUILDER_PRODUCT_VERSION : ( defined( 'ET_BUILDER_VERSION' ) ? ET_BUILDER_VERSION : null );
}

function f2d_clear_divi_cache( $post_id ) {
	f2d_as_admin();
	$done = array();
	if ( class_exists( 'ET_Core_PageResource' ) ) {
		ET_Core_PageResource::remove_static_resources( $post_id, 'all', true );
		$done[] = 'remove_static_resources';
	}
	$dirs = array( WP_CONTENT_DIR . '/et-cache/' . (int) $post_id );
	foreach ( $dirs as $d ) {
		if ( is_dir( $d ) ) {
			foreach ( glob( $d . '/*' ) as $f ) {
				if ( is_file( $f ) ) {
					unlink( $f );
				}
			}
			$done[] = 'rm ' . basename( $d );
		}
	}
	foreach ( array( 'et_enqueued_post_fonts', '_et_dynamic_cached_shortcodes', '_et_dynamic_cached_attributes', '_et_builder_module_features_cache' ) as $k ) {
		delete_post_meta( $post_id, $k );
	}
	clean_post_cache( $post_id );
	return $done;
}

function f2d_history( $post_id ) {
	$hist = get_post_meta( $post_id, F2D_META_HISTORY, true );
	return is_array( $hist ) ? array_values( array_filter( $hist, 'is_array' ) ) : array();
}

function f2d_snapshot( $post_id ) {
	$hist = f2d_history( $post_id );
	$build = json_decode( (string) get_post_meta( $post_id, F2D_META_BUILD, true ), true );
	$hist[] = array(
		'build_id'   => $build['build_id'] ?? null,
		'content'    => get_post_field( 'post_content', $post_id, 'raw' ),
		'css'        => get_post_meta( $post_id, '_et_pb_custom_css', true ),
		'saved_at'   => gmdate( 'c' ),
	);
	$hist = array_slice( $hist, -F2D_HISTORY_MAX );
	update_post_meta( $post_id, F2D_META_HISTORY, wp_slash( $hist ) );
	return count( $hist );
}

function f2d_deploy( $args ) {
	f2d_as_admin();
	$page_key = $args['page_key'];
	$content  = $args['content'];
	$css      = $args['css'];
	$found    = f2d_find_page( $page_key );
	if ( is_wp_error( $found ) ) {
		return $found;
	}
	$status = $args['status'] ?? 'draft';
	if ( 'publish' === $status && empty( $args['allow_publish'] ) ) {
		return new WP_Error( 'f2d_publish_blocked', 'Publishing requires explicit approval (allow_publish).' );
	}
	if ( $found && get_post_status( $found ) === 'publish' && 'publish' !== $status && empty( $args['allow_publish'] ) ) {
		return new WP_Error( 'f2d_published_page', "Page {$found} is published; updating it requires explicit approval." );
	}
	$snapshots = 0;
	$postarr   = array(
		'post_type'    => 'page',
		'post_title'   => $args['title'],
		'post_content' => $content,
		'post_status'  => $status,
	);
	if ( $found ) {
		$snapshots     = f2d_snapshot( $found );
		$postarr['ID'] = $found;
		if ( empty( $args['allow_publish'] ) ) {
			$postarr['post_status'] = get_post_status( $found ) === 'publish' ? 'publish' : $status;
		}
		$id = wp_update_post( wp_slash( $postarr ), true );
	} else {
		if ( ! empty( $args['slug'] ) ) {
			$postarr['post_name'] = sanitize_title( $args['slug'] );
		}
		$id = wp_insert_post( wp_slash( $postarr ), true );
	}
	if ( is_wp_error( $id ) ) {
		return $id;
	}
	$divi = f2d_divi_version();
	update_post_meta( $id, F2D_META_KEY, $page_key );
	update_post_meta( $id, '_et_pb_use_builder', 'on' );
	update_post_meta( $id, '_et_pb_built_for_post_type', 'page' );
	update_post_meta( $id, '_et_pb_show_page_creation', 'off' );
	update_post_meta( $id, '_et_builder_version', 'VB|Divi|' . $divi );
	update_post_meta( $id, '_et_pb_custom_css', wp_slash( $css ) );
	update_post_meta( $id, '_f2d_font_urls', wp_slash( wp_json_encode( array_values( (array) ( $args['fonts'] ?? array() ) ) ) ) );
	update_post_meta(
		$id,
		F2D_META_BUILD,
		wp_slash(
			wp_json_encode(
				array(
					'build_id'     => $args['build_id'],
					'page_key'     => $page_key,
					'deployed_at'  => gmdate( 'c' ),
					'divi_version' => $divi,
					'bridge'       => F2D_BRIDGE_VERSION,
				)
			)
		)
	);
	$cleared = f2d_clear_divi_cache( $id );
	return array(
		'post_id'     => $id,
		'created'     => ! $found,
		'status'      => get_post_status( $id ),
		'snapshots'   => $snapshots,
		'cache'       => $cleared,
		'permalink'   => get_permalink( $id ),
		'preview_url' => f2d_preview_allowed() ? add_query_arg( array( 'page_id' => $id, 'f2d_preview' => f2d_preview_token( $id ) ), home_url( '/' ) ) : null,
		'divi'        => $divi,
	);
}

function f2d_readback( $post_id ) {
	$content = get_post_field( 'post_content', $post_id, 'raw' );
	return array(
		'post_id'      => (int) $post_id,
		'status'       => get_post_status( $post_id ),
		'content'      => $content,
		'content_sha'  => hash( 'sha256', $content ),
		'css_sha'      => hash( 'sha256', (string) get_post_meta( $post_id, '_et_pb_custom_css', true ) ),
		'use_builder'  => get_post_meta( $post_id, '_et_pb_use_builder', true ),
		'build'        => json_decode( (string) get_post_meta( $post_id, F2D_META_BUILD, true ), true ),
		'history'      => array_map(
			function ( $h ) {
				return array( 'build_id' => $h['build_id'], 'saved_at' => $h['saved_at'] );
			},
			f2d_history( $post_id )
		),
		'divi'         => f2d_divi_version(),
		'shortcodes_ok'=> function_exists( 'et_pb_is_pagebuilder_used' ) ? et_pb_is_pagebuilder_used( $post_id ) : null,
	);
}

function f2d_rollback( $post_id, $build_id = null ) {
	f2d_as_admin();
	$hist = f2d_history( $post_id );
	if ( ! $hist ) {
		return new WP_Error( 'f2d_no_history', 'No snapshots for this page.' );
	}
	$pick = null;
	foreach ( array_reverse( $hist, true ) as $i => $h ) {
		if ( null === $build_id || $h['build_id'] === $build_id ) {
			$pick = $h;
			break;
		}
	}
	if ( ! $pick ) {
		return new WP_Error( 'f2d_no_snapshot', "No snapshot for build {$build_id}." );
	}
	f2d_snapshot( $post_id );
	wp_update_post( wp_slash( array( 'ID' => $post_id, 'post_content' => $pick['content'] ) ) );
	update_post_meta( $post_id, '_et_pb_custom_css', wp_slash( (string) $pick['css'] ) );
	$build             = json_decode( (string) get_post_meta( $post_id, F2D_META_BUILD, true ), true ) ?: array();
	$build['build_id'] = $pick['build_id'];
	$build['rolled_back_at'] = gmdate( 'c' );
	update_post_meta( $post_id, F2D_META_BUILD, wp_slash( wp_json_encode( $build ) ) );
	f2d_clear_divi_cache( $post_id );
	return array( 'post_id' => (int) $post_id, 'restored_build' => $pick['build_id'] );
}

// Import local files into the media library, deduplicated by content hash.
function f2d_import_media( $items ) {
	f2d_as_admin();
	require_once ABSPATH . 'wp-admin/includes/file.php';
	require_once ABSPATH . 'wp-admin/includes/media.php';
	require_once ABSPATH . 'wp-admin/includes/image.php';
	$out = array();
	foreach ( $items as $it ) {
		$hash = $it['hash'];
		$ex   = get_posts( array( 'post_type' => 'attachment', 'post_status' => 'inherit', 'meta_key' => '_f2d_asset_hash', 'meta_value' => $hash, 'posts_per_page' => 1, 'fields' => 'ids' ) );
		if ( $ex ) {
			$out[ $it['key'] ] = array( 'id' => $ex[0], 'url' => wp_get_attachment_url( $ex[0] ), 'reused' => true );
			continue;
		}
		if ( ! is_readable( $it['file'] ) ) {
			$out[ $it['key'] ] = array( 'error' => 'unreadable file' );
			continue;
		}
		$tmp = wp_tempnam( basename( $it['file'] ) );
		copy( $it['file'], $tmp );
		$file = array( 'name' => $it['name'] ?? basename( $it['file'] ), 'tmp_name' => $tmp );
		$id   = media_handle_sideload( $file, 0, $it['title'] ?? null );
		if ( is_wp_error( $id ) ) {
			@unlink( $tmp );
			$out[ $it['key'] ] = array( 'error' => $id->get_error_message() );
			continue;
		}
		update_post_meta( $id, '_f2d_asset_hash', $hash );
		$out[ $it['key'] ] = array( 'id' => $id, 'url' => wp_get_attachment_url( $id ), 'reused' => false );
	}
	return $out;
}

// Global colours: namespaced gcid-f2d-* entries merged into Divi's palette, never replacing others.
function f2d_set_global_colors( $colors ) {
	$opt = get_option( 'et_divi_builder_plugin', array() );
	$opt = is_array( $opt ) ? $opt : array();
	$gc  = isset( $opt['et_global_colors'] ) && is_array( $opt['et_global_colors'] ) ? $opt['et_global_colors'] : array();
	foreach ( $colors as $id => $color ) {
		if ( strpos( $id, 'gcid-f2d-' ) !== 0 ) {
			continue;
		}
		$gc[ $id ] = array( 'color' => $color, 'active' => 'yes' );
	}
	$opt['et_global_colors'] = $gc;
	update_option( 'et_divi_builder_plugin', $opt );
	return array_keys( array_filter( $gc, function ( $k ) { return strpos( $k, 'gcid-f2d-' ) === 0; }, ARRAY_FILTER_USE_KEY ) );
}

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	require_once __DIR__ . '/includes/cli.php';
}

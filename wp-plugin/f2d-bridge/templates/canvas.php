<?php
/**
 * Blank canvas for f2d-generated pages: no theme header/footer/template parts.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?><!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo( 'charset' ); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>
<style id="f2d-canvas-base">html,body{margin:0;padding:0}body.f2d-page{background:#fff}</style>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<?php
while ( have_posts() ) {
	the_post();
	the_content();
}
?>
<?php wp_footer(); ?>
</body>
</html>

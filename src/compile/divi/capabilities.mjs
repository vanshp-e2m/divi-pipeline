// Verified capability profiles per Divi version. A module appears here only after its attribute
// format was checked against that version's source (docs/DIVI4-NOTES.md).
const DIVI_4_27 = {
  id: 'divi-4.27',
  match: /^4\.(2[4-9])(\.|$)/,
  verifiedWith: '4.27.7',
  structure: ['et_pb_section', 'et_pb_row', 'et_pb_column'],
  modules: ['et_pb_section', 'et_pb_text', 'et_pb_image', 'et_pb_button', 'et_pb_divider', 'et_pb_code'],
  // Present in 4.27.7 but not yet used by the compiler (candidates for interaction fidelity).
  available: ['et_pb_toggle', 'et_pb_accordion', 'et_pb_contact_form', 'et_pb_slider', 'et_pb_testimonial', 'et_pb_menu', 'et_pb_blurb', 'et_pb_icon', 'et_pb_number_counter', 'et_pb_heading'],
  meta: ['_et_pb_use_builder', '_et_pb_built_for_post_type', '_et_pb_show_page_creation', '_et_builder_version', '_et_pb_custom_css'],
};

export function capabilities(version) {
  if (!version) return null;
  return [DIVI_4_27].find((c) => c.match.test(version)) || null;
}

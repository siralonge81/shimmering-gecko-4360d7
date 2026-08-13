/**
 * Fixed prompts for the sample films shown on the dashboard, the marketplace
 * and the leaderboard. Each one is generated at most once and then cached in
 * Netlify Blobs forever, so the catalogue costs a handful of images in total.
 */
export const POSTERS: Record<string, { title: string; prompt: string }> = {
  'rain-over-lagos': {
    title: 'Rain Over Lagos',
    prompt:
      'Five figures in soaked jackets stand apart in a rain-hammered waterfront courtyard in Lagos at night, ' +
      'sodium streetlight cutting through the downpour, wet concrete throwing back orange reflections, ' +
      'a single bare bulb swinging over a gate. Wide, slightly low angle, deep shadows.',
  },
  'the-last-danfo': {
    title: 'The Last Danfo',
    prompt:
      'A battered yellow Lagos danfo minibus stranded mid-street in bright afternoon haze, its driver ' +
      'leaning out of the window mid-argument with a hawker, market awnings and stacked crates crowding ' +
      'the frame. Warm, saturated daylight, handheld medium wide, comic energy.',
  },
  harmattan: {
    title: 'Harmattan',
    prompt:
      'A family compound at dawn under harmattan dust, pale ochre air flattening the light, an elderly ' +
      'woman in a faded wrapper standing in a doorway watching a young man carry a suitcase across the ' +
      'yard. Soft diffused haze, muted earth palette, quiet wide shot.',
  },
  'okada-nights': {
    title: 'Okada Nights',
    prompt:
      'A motorcycle taxi rider seen from behind, weaving through night traffic on a Lagos expressway, ' +
      'headlights smearing into long streaks, helmet visor catching red tail lights. Tight tracking shot, ' +
      'motion blur, high contrast, thriller tension.',
  },
  'blue-hour-market': {
    title: 'Blue Hour Market',
    prompt:
      'A near-future open-air market at blue hour, holographic price tags floating over produce stalls, ' +
      'vendors in layered technical fabrics, drones drifting between canopies, distant tower blocks ' +
      'silhouetted against a teal sky. Wide establishing shot, cool palette with warm stall lanterns.',
  },
  'third-mainland': {
    title: 'Third Mainland',
    prompt:
      'Two people at opposite ends of a car back seat crossing a long bridge over dark water at dusk, ' +
      'city lights sliding past the window, one turned toward the glass, the other watching them. ' +
      'Intimate two-shot through the windscreen, golden and indigo, romantic melancholy.',
  },
  'featured-hero': {
    title: 'Rain Over Lagos — key art',
    prompt:
      'Ultra-wide cinematic key art: a lone figure in a soaked overcoat standing under a flickering ' +
      'gantry light on a rain-drenched Lagos waterfront at night, the harbour and container cranes ' +
      'behind them, the left third of the frame falling into near-black for title placement. ' +
      'Anamorphic flare, heavy rain, deep oxblood and petrol grade.',
  },
}

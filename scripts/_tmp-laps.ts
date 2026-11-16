process.env.ENDURANCE_REPORT_LIB = '1';
(async () => {
  const R = await import('./endurance-report');
  const c = R.CASES.find((x) => x.id === process.argv[2])!;
  const r = R.laps(c);
  for (const l of r?.laps ?? []) console.log(JSON.stringify(l));
  console.log('soc start', r?.socStartPct, 'swing', r?.socSwingPct);
})();

require('esbuild').buildSync({ entryPoints: ['src/app.js'], bundle: true, outfile: 'public/app.js', format: 'iife', target: ['safari15.4','chrome100'], minify: true, legalComments: 'eof' });
console.log('V6 browser bundle built');

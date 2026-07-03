#!/bin/sh
if [ "$#" -eq 0 ]; then
    set -- --target safari
fi
npm run-script build -- "$@"

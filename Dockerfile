FROM twentycrm/twenty:latest

USER root

COPY patch.sh /tmp/patch.sh
COPY inject-debug.js /tmp/inject-debug.js
RUN chmod +x /tmp/patch.sh && /tmp/patch.sh && rm /tmp/patch.sh /tmp/inject-debug.js

USER 1000

CMD ["node", "dist/main"]
ENTRYPOINT ["/app/entrypoint.sh"]

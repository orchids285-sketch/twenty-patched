FROM twentycrm/twenty:latest

USER root

COPY patch.sh /tmp/patch.sh
COPY inject-debug.js /tmp/inject-debug.js
COPY patch-google.js /tmp/patch-google.js
# Normalize line endings in case files were committed with CRLF
RUN sed -i 's/\r$//' /tmp/patch.sh && chmod +x /tmp/patch.sh \
  && /tmp/patch.sh \
  && rm /tmp/patch.sh /tmp/inject-debug.js /tmp/patch-google.js

USER 1000

CMD ["node", "dist/main"]
ENTRYPOINT ["/app/entrypoint.sh"]

#!/bin/bash

FLAG_FILE="/usr/src/app/.initialized"

if [ ! -f $FLAG_FILE ]; then
  # Run the script to index documents to OpenSearch
  python docs_to_openSearch.py
  touch $FLAG_FILE
fi

# Start Streamlit
streamlit run app.py
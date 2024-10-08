import streamlit as st
from query_against_openSearch import answer_query

# Header/Title of streamlit app
st.title(f""":blue[RAG with Amazon OpenSearch Serverless Vector Search : MLA-C01 Certification Preparation]""")

# configuring values for session state
if "messages" not in st.session_state:
    st.session_state.messages = []
# writing the message that is stored in session state
for message in st.session_state.messages:
    with st.chat_message(message["role"]):
        st.markdown(message["content"])
# adding some special effects from the UI perspective
st.snow()
# evaluating st.chat_input and determining if a question has been input
if question := st.chat_input("Simply ask me about any TOPIC from MLA-C01 Certification and I will generate questions..."):
    # with the user icon, write the question to the front end
    with st.chat_message("user"):
        st.markdown(question)
    # append the question and the role (user) as a message to the session state
    st.session_state.messages.append({"role": "user",
                                      "content": question})
    # respond as the assistant with the answer
    with st.chat_message("assistant"):
        # making sure there are no messages present when generating the answer
        message_placeholder = st.empty()
        # putting a spinning icon to show that the query is in progress
        with st.status("Generating the MCQ Question Set!", expanded=False) as status:
            # passing the question into the LLM with the Conversation API to generate an answer and preserve Context
            answer = answer_query(question)
            # writing the answer to the front end
            message_placeholder.markdown(f"{answer}")
            # showing a completion message to the front end
            status.update(label="MCQ Generated...", state="complete", expanded=False)
    # appending the results to the session state
    st.session_state.messages.append({"role": "assistant",
                                      "content": answer})